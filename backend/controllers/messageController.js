const { Pool } = require('pg');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const pool = require('../database/database.js');

// Generate fake base64 decoy content
const generateDecoy = (originalMessageLength) => {
  // Create realistic decoy length (1.3x to 1.8x original length)
  const multiplier = 1.3 + (Math.random() * 0.5);
  const targetLength = Math.ceil(originalMessageLength * multiplier);
  
  // Generate random bytes and convert to base64
  const randomBytes = crypto.randomBytes(targetLength);
  let decoy = randomBytes.toString('base64');
  
  // Add some realistic-looking structure occasionally
  if (Math.random() > 0.5) {
    // Insert some dots, equals signs, and slashes to make it look more authentic
    const insertions = ['...', '==', '//', '::'];
    const randomInsertion = insertions[Math.floor(Math.random() * insertions.length)];
    const insertPosition = Math.floor(decoy.length * Math.random());
    decoy = decoy.slice(0, insertPosition) + randomInsertion + decoy.slice(insertPosition);
  }
  
  // Ensure minimum length for very short messages
  if (decoy.length < 50) {
    decoy += crypto.randomBytes(30).toString('base64');
  }
  
  return decoy;
};


// Revolutionary encryption (sender-controlled)
const encryptMessage = (content, senderKey) => {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(senderKey, 'vanish-salt', 32);
  const iv = crypto.randomBytes(16);
  
  const cipher = crypto.createCipher(algorithm, key);
  let encrypted = cipher.update(content, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return {
    encrypted: encrypted,
    iv: iv.toString('hex')
  };
};

// Calculate self-destruction time based on message length
const calculateDestructionTime = (messageLength) => {
  if (messageLength <= 50) return 60;      // 1 minute
  if (messageLength <= 200) return 120;    // 2 minutes
  if (messageLength <= 500) return 180;    // 3 minutes
  return 240;                              // 4 minutes
};

// Send encrypted message
const sendMessage = async (req, res) => {
  // This function is currently not used by the frontend, which uses sockets.
  // However, updating it ensures API consistency.
  // This logic should MIRROR the socket.on('send_message') handler.
  try {
    const senderId = req.user.id;
    const { conversation_id, content, sender_key, key_hint, message_type = 'text' } = req.body;

    if (!conversation_id || !content || !sender_key) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Encrypt the real content
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(sender_key, 'vanish-salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(content, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const encryptedContent = `${encrypted}:${iv.toString('hex')}`;

    // Generate decoy
    const decoyContent = generateDecoy(content.length);
    const destructionTimer = calculateDestructionTime(content.length);

    // Store message with NEW decoy columns
    const result = await pool.query(`
      INSERT INTO messages (
        conversation_id, sender_id, content, message_type, 
        sender_key_hint, self_destruct_timer, decoy_content, 
        is_encrypted_display, is_seen, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) 
      RETURNING *
    `, [conversation_id, senderId, encryptedContent, message_type, key_hint, destructionTimer, decoyContent, true, false]);

    const message = result.rows[0];

    // Update conversation last message time
    await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation_id]);

    // Return the new message format
    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: {
        ...message,
        content: message.decoy_content, // Return the decoy as the content
      }
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
};

// Request decryption (revolutionary feature)
const requestDecryption = async (req, res) => {
  try {
    const requesterId = req.user.id;
    const { messageId } = req.params;

    // Get message details
    const messageResult = await pool.query(
      'SELECT * FROM messages WHERE id = $1',
      [messageId]
    );

    if (messageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const message = messageResult.rows[0];

    // Check if requester is in the conversation
    const participantCheck = await pool.query(
      'SELECT id FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [message.conversation_id, requesterId]
    );

    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to request decryption' });
    }

    // Don't allow sender to request their own message decryption
    if (message.sender_id === requesterId) {
      return res.status(400).json({ error: 'Cannot request decryption of your own message' });
    }

    // Check if already decrypted
    if (message.is_decrypted) {
      return res.status(400).json({ error: 'Message already decrypted' });
    }

    // Check for existing pending request
    const existingRequest = await pool.query(
      'SELECT id FROM decryption_requests WHERE message_id = $1 AND requester_id = $2 AND status = $3',
      [messageId, requesterId, 'pending']
    );

    if (existingRequest.rows.length > 0) {
      return res.status(400).json({ error: 'Decryption request already pending' });
    }

    // Create decryption request
    const requestResult = await pool.query(`
      INSERT INTO decryption_requests (
        message_id, 
        requester_id, 
        sender_id, 
        status
      ) VALUES ($1, $2, $3, 'pending') 
      RETURNING *
    `, [messageId, requesterId, message.sender_id]);

    res.json({
      success: true,
      message: 'Decryption request sent to sender',
      request: requestResult.rows[0]
    });

  } catch (error) {
    console.error('Request decryption error:', error);
    res.status(500).json({ error: 'Failed to request decryption' });
  }
};

// Get conversation messages
const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const participantCheck = await pool.query(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to view these messages' });
    }

    // THE FIX IS IN THIS QUERY:
    const query = `
      SELECT 
        m.id, m.conversation_id, m.sender_id,
        CASE 
          WHEN m.is_encrypted_display = true AND m.message_type = 'text' THEN m.decoy_content
          WHEN m.message_type = 'file' THEN '[Encrypted File]' -- A clean placeholder for file content
          ELSE m.content
        END as content,
        m.message_type,
        m.ephemeral_type,        -- **FIX 1/2**: Add this line
        m.file_metadata,         -- **FIX 2/2**: Add this line
        m.is_encrypted_display, m.is_decrypted,
        m.is_seen, m.self_destruct_timer, m.expires_at, m.created_at,
        u.username as sender_username
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM user_message_deletions umd
        WHERE umd.message_id = m.id AND umd.user_id = $2
      )
      AND (m.expires_at IS NULL OR m.expires_at > NOW())
      ORDER BY m.created_at ASC;
    `;
    const result = await pool.query(query, [conversationId, userId]);

    res.json({
      success: true,
      messages: result.rows
    });

  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

// Get pending decryption requests for sender
const getPendingRequests = async (req, res) => {
  try {
    const senderId = req.user.id;

    const result = await pool.query(`
      SELECT 
        dr.*,
        m.sender_key_hint,
        m.conversation_id,
        u.username as requester_username,
        u.profile_photo as requester_photo
      FROM decryption_requests dr
      JOIN messages m ON dr.message_id = m.id
      JOIN users u ON dr.requester_id = u.id
      WHERE dr.sender_id = $1 AND dr.status = 'pending'
      ORDER BY dr.requested_at DESC
    `, [senderId]);

    res.json({
      success: true,
      requests: result.rows
    });

  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({ error: 'Failed to fetch pending requests' });
  }
};

module.exports = {
  sendMessage,
  requestDecryption,
  getMessages,
  getPendingRequests
};
