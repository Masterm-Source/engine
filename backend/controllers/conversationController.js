const { Pool } = require('pg');

const pool = require('../database/database.js');

// Get user's conversations (WhatsApp-like chat list)
const getUserConversations = async (req, res) => {
  try {
    const userId = req.user.id;
    const query = `
      SELECT 
        c.id,
        c.type,
        c.created_at,
        c.last_message_at,
        -- CORRECTED LOGIC: Get nickname from 'contacts' table, not 'conversation_participants'
        COALESCE(contacts.nickname, u.username) as display_name,
        u.is_online as contact_online,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
        (
          SELECT COUNT(*) 
          FROM messages m 
          WHERE m.conversation_id = c.id 
          AND m.sender_id != $1 
          AND m.is_seen = false
        ) as unread_count
      FROM conversations c
      JOIN conversation_participants cp ON c.id = cp.conversation_id
      -- Find the other participant in the conversation
      LEFT JOIN conversation_participants cp_alias ON c.id = cp_alias.conversation_id AND cp_alias.user_id != $1
      -- Get the other participant's user details
      LEFT JOIN users u ON cp_alias.user_id = u.id
      -- CORRECTED JOIN: Join the 'contacts' table to find the nickname the current user has set for the other participant
      LEFT JOIN contacts ON contacts.user_id = $1 AND contacts.contact_id = cp_alias.user_id
      WHERE cp.user_id = $1 AND c.type = 'direct'
      ORDER BY c.last_message_at DESC;
    `;
    const result = await pool.query(query, [userId]);

    res.json({
      success: true,
      conversations: result.rows
    });

  } catch (error) {
    console.error('Get user conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
};

// Create direct conversation with a contact
// Create direct conversation with a contact
const createDirectConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contact_id } = req.body;

    if (!contact_id) {
      return res.status(400).json({ error: 'Contact ID required' });
    }

    if (contact_id == userId) {
      return res.status(400).json({ error: 'Cannot create conversation with yourself' });
    }

    // --- NEW BLOCK CHECK ---
    // This query checks if either user has blocked the other.
    const blockedCheck = await pool.query(
        'SELECT id FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
        [userId, contact_id]
    );
    if (blockedCheck.rows.length > 0) {
        return res.status(403).json({ error: 'Action forbidden. You cannot start a conversation with this user.' });
    }
    // --- END BLOCK CHECK ---

    // Check if contact exists
    const contactCheck = await pool.query(
      'SELECT id, username FROM users WHERE id = $1',
      [contact_id]
    );

    if (contactCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Check if direct conversation already exists
    const existingConversation = await pool.query(`
      SELECT c.id
      FROM conversations c
      JOIN conversation_participants cp1 ON c.id = cp1.conversation_id
      JOIN conversation_participants cp2 ON c.id = cp2.conversation_id
      WHERE c.type = 'direct' 
        AND cp1.user_id = $1 
        AND cp2.user_id = $2
        AND (
          SELECT COUNT(*) 
          FROM conversation_participants cp3 
          WHERE cp3.conversation_id = c.id
        ) = 2
    `, [userId, contact_id]);

    if (existingConversation.rows.length > 0) {
      return res.status(200).json({
        success: true,
        message: 'Conversation already exists',
        conversation_id: existingConversation.rows[0].id
      });
    }

    // Create new direct conversation
    const conversationResult = await pool.query(
      'INSERT INTO conversations (type, created_by) VALUES ($1, $2) RETURNING *',
      ['direct', userId]
    );

    const conversationId = conversationResult.rows[0].id;

    // Add both participants
    await pool.query(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
      [conversationId, userId, contact_id]
    );

    res.status(201).json({
      success: true,
      message: 'Direct conversation created',
      conversation: {
        ...conversationResult.rows[0],
        display_name: contactCheck.rows[0].username,
        participant_count: 2
      }
    });

  } catch (error) {
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
};

// Create group conversation
const createGroupConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, participant_ids = [] } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name required' });
    }

    if (!Array.isArray(participant_ids) || participant_ids.length === 0) {
      return res.status(400).json({ error: 'At least one participant required' });
    }

    // Create group conversation
    const conversationResult = await pool.query(
      'INSERT INTO conversations (type, name, created_by) VALUES ($1, $2, $3) RETURNING *',
      ['group', name.trim(), userId]
    );

    const conversationId = conversationResult.rows[0].id;

    // Add creator as participant
    const allParticipants = [userId, ...participant_ids.filter(id => id != userId)];
    
    // Insert all participants
    const participantValues = allParticipants.map((id, index) => 
      `($1, $${index + 2})`
    ).join(', ');

    const participantQuery = `
      INSERT INTO conversation_participants (conversation_id, user_id) 
      VALUES ${participantValues}
    `;

    await pool.query(participantQuery, [conversationId, ...allParticipants]);

    res.status(201).json({
      success: true,
      message: 'Group conversation created',
      conversation: {
        ...conversationResult.rows[0],
        participant_count: allParticipants.length
      }
    });

  } catch (error) {
    console.error('Create group conversation error:', error);
    res.status(500).json({ error: 'Failed to create group conversation' });
  }
};

// Get conversation details
const getConversationDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;

    // Verify user is participant
    const participantCheck = await pool.query(
      'SELECT id FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to view this conversation' });
    }

    // Get conversation details
    const conversationResult = await pool.query(
      'SELECT * FROM conversations WHERE id = $1',
      [conversationId]
    );

    if (conversationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Get participants
    const participantsResult = await pool.query(`
      SELECT 
        u.id,
        u.username,
        u.bio,
        u.profile_photo,
        u.is_online,
        u.last_seen,
        cp.joined_at
      FROM conversation_participants cp
      JOIN users u ON cp.user_id = u.id
      WHERE cp.conversation_id = $1
      ORDER BY cp.joined_at ASC
    `, [conversationId]);

    const conversation = conversationResult.rows[0];

    res.json({
      success: true,
      conversation: {
        ...conversation,
        participants: participantsResult.rows
      }
    });

  } catch (error) {
    console.error('Get conversation details error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation details' });
  }
};

// Leave conversation
const leaveConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;

    // Remove user from conversation
    const result = await pool.query(
      'DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 RETURNING *',
      [conversationId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not a participant in this conversation' });
    }

    // Check if conversation has any participants left
    const remainingParticipants = await pool.query(
      'SELECT COUNT(*) as count FROM conversation_participants WHERE conversation_id = $1',
      [conversationId]
    );

    // If no participants left, delete conversation
    if (remainingParticipants.rows[0].count === '0') {
      await pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
    }

    res.json({
      success: true,
      message: 'Left conversation successfully'
    });

  } catch (error) {
    console.error('Leave conversation error:', error);
    res.status(500).json({ error: 'Failed to leave conversation' });
  }
};

// (This should be inside conversationController.js)

const deleteConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;

    // This is a "soft delete" for the user. We remove their participation.
    // A more complex system might hide it, but for simplicity, we remove them.
    // This assumes that if one person deletes, the conversation disappears for them.
    
    // In a group chat, this would just be "leaving". For a DM, it effectively deletes it for that user.
    await pool.query(
      'DELETE FROM conversation_participants WHERE user_id = $1 AND conversation_id = $2',
      [userId, conversationId]
    );

    // Optional: Also delete their specific conversation key if they set one
    await pool.query(
        'DELETE FROM conversation_keys WHERE user_id = $1 AND conversation_id = $2',
        [userId, conversationId]
    );

    res.status(200).json({ success: true, message: 'Conversation has been removed' });

  } catch (error) {
    console.error('Delete conversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
};

module.exports = {
  getUserConversations,
  createDirectConversation,
  createGroupConversation,
  getConversationDetails,
  leaveConversation,
  deleteConversation,
};
