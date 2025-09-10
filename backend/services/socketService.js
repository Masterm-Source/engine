const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');

const pool = require('../database/database.js');

// (Add this new helper function near the top of socketService.js)
const verifyChannelIntegrity = async (userId1, userId2) => {
  const result = await pool.query(
    'SELECT id FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
    [userId1, userId2]
  );
  return result.rows.length > 0;
};


// Decrypt message with sender's key
const resolveWithProof = (encryptedContent, senderKey) => {
  try {
    const [encrypted, ivHex] = encryptedContent.split(':');
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(senderKey, 'vanish-salt', 32);
    const iv = Buffer.from(ivHex, 'hex');
    
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    throw new Error('Invalid decryption key');
  }
};

// Generate fake base64 decoy content
const mapToTransient = (targetLength) => {
  const scrambleChars = '█▓▒░ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let decoy = '';
  for (let i = 0; i < targetLength; i++) {
    decoy += scrambleChars[Math.floor(Math.random() * scrambleChars.length)];
  }
  return decoy;
};
// Initialize Socket.IO with revolutionary features
const initializeSocket = (io, authenticateSocket, handleDisconnect) => {
  
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    console.log(`🔗 User connected: ${socket.user.username} (ID: ${socket.user.id})`);

    // Join user to their personal room for notifications
    socket.join(`user_${socket.user.id}`);

    socket.on('join_conversation', (data) => {
    const { conversation_id } = data;
    socket.join(`conversation_${conversation_id}`);
    console.log(`📲 User ${socket.user.username} successfully joined room: conversation_${conversation_id}`);
});

    // Join user to their conversation rooms
    joinUserConversations(socket);
    
    // Live Typing Preview handler
    socket.on('stream_buffer', async (data) => {
    try {
        const { conversation_id, text_length } = data;
        if (typeof text_length !== 'number' || text_length < 0 || text_length > 5000) return;
        
        // --- BLOCK CHECK ---
        const recipients = await pool.query('SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2', [conversation_id, socket.user.id]);
        if (recipients.rows.length > 0) {
          const recipientId = recipients.rows[0].user_id;
          if (await verifyChannelIntegrity(socket.user.id, recipientId)) {
            return; // Silently fail to prevent broadcasting typing to a blocked user
          }
        }
        // --- END BLOCK CHECK ---
        
        const liveDecoy = mapToTransient(text_length);
        const payload = {
            conversation_id,
            sender_id: socket.user.id,
            sender_username: socket.user.username,
            decoy_content: liveDecoy
        };
        
        socket.to(`conversation_${conversation_id}`).emit('live_decoy_update', payload);
    } catch (error) {
        console.error('Live typing update error:', error);
        // We don't emit an error to the client here to avoid spamming them.
    }
});
    socket.on('mark_conversation_as_read', async (data) => {
  try {
    const { conversation_id } = data;
    const userId = socket.user.id;

    const updateResult = await pool.query(
      `UPDATE messages SET is_seen = true 
       WHERE conversation_id = $1 AND sender_id != $2 AND is_seen = false
       RETURNING id, sender_id`,
      [conversation_id, userId]
    );

    // Notify the senders that their messages have been seen
    const notifications = {};
    for (const row of updateResult.rows) {
      if (!notifications[row.sender_id]) {
        notifications[row.sender_id] = [];
      }
      notifications[row.sender_id].push(row.id);
    }

    for (const senderId in notifications) {
      io.to(`user_${senderId}`).emit('messages_seen_update', {
        message_ids: notifications[senderId],
        conversation_id: conversation_id
      });
    }

  } catch (error) {
    console.error('Mark as read error:', error);
  }
});

// Handle creation of a file message after upload
// === DEFINITIVE REPLACEMENT for send_file_message ===
socket.on('send_file_message', async (data) => {
    try {
        const { conversation_id, sender_key, file_metadata, ephemeral_type } = data;
        const senderId = socket.user.id;

        const contentPayload = {
            originalName: file_metadata.originalName,
            size: file_metadata.size
        };

        const algorithm = 'aes-256-cbc';
        const key = crypto.scryptSync(sender_key, 'vanish-salt', 32);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(algorithm, key, iv);
        let encryptedContent = cipher.update(JSON.stringify(contentPayload), 'utf8', 'hex');
        encryptedContent += cipher.final('hex');
        const finalEncryptedContent = `${encryptedContent}:${iv.toString('hex')}`;

        const decoyContent = mapToTransient(file_metadata.originalName.length + 20);

        const serverMetadata = {
            path: file_metadata.path,
            mimeType: file_metadata.mimeType
        };

        const result = await pool.query(`
            INSERT INTO messages (conversation_id, sender_id, content, decoy_content, message_type, file_metadata, ephemeral_type, is_encrypted_display, created_at)
            VALUES ($1, $2, $3, $4, 'file', $5, $6, true, NOW())
            RETURNING *
        `, [conversation_id, senderId, finalEncryptedContent, decoyContent, serverMetadata, ephemeral_type]);
        const message = result.rows[0];
        
        await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation_id]);

        // **THE FIX**: This object now perfectly mirrors the API structure.
        const messageData = {
            id: message.id,
            conversation_id: message.conversation_id,
            sender_id: message.sender_id,
            message_type: 'file',
            file_metadata: message.file_metadata, // This is the crucial addition.
            ephemeral_type: message.ephemeral_type,
            is_encrypted_display: true,
            is_decrypted: false,
            is_seen: false,
            created_at: message.created_at,
            content: message.decoy_content 
        };
        io.to(`conversation_${conversation_id}`).emit('new_message', messageData);

    } catch (error) {
        console.error('Send file message error:', error);
        socket.emit('error', { message: 'Failed to send file message.' });
    }
});
    // Handle joining conversation rooms
    socket.on('join_conversation', async (data) => {
      try {
        const { conversation_id } = data;
        
        // Verify user is participant
        const participantCheck = await pool.query(
          'SELECT id FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
          [conversation_id, socket.user.id]
        );

        if (participantCheck.rows.length > 0) {
          socket.join(`conversation_${conversation_id}`);
          console.log(`📱 ${socket.user.username} joined conversation ${conversation_id}`);
        }
      } catch (error) {
        console.error('Join conversation error:', error);
      }
    });

    // REPLACE your entire send_message handler (around lines 75-130) with this:

    socket.on('dispatch_payload', async (data) => {
  try {
    const { conversation_id, content, sender_key, message_type = 'text' } = data;
    const senderId = socket.user.id;
    
    const participantCheck = await pool.query(
      'SELECT id FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [conversation_id, senderId]
    );
    if (participantCheck.rows.length === 0) {
      return socket.emit('error', { message: 'Not authorized to send messages' });
    }

    const recipients = await pool.query('SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2', [conversation_id, senderId]);
if (recipients.rows.length > 0) {
  const recipientId = recipients.rows[0].user_id; // Assuming DM for now
  if (await verifyChannelIntegrity(senderId, recipientId)) {
    return socket.emit('error', { message: 'Cannot send message. This user is blocked.' });
  }
}

    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(sender_key, 'vanish-salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(content, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const encryptedContent = `${encrypted}:${iv.toString('hex')}`;

    // Generate the final, static decoy for the permanent message bubble.
    const staticDecoy = mapToTransient(content.length <= 50 ? content.length + 10 : content.length + 20);

    const destructionTimer = content.length <= 50 ? 60 : 
                           content.length <= 200 ? 120 : 
                           content.length <= 500 ? 180 : 240;

    const result = await pool.query(`
      INSERT INTO messages (conversation_id, sender_id, content, decoy_content, message_type, self_destruct_timer, is_encrypted_display, created_at) 
      VALUES ($1, $2, $3, $4, $5, $6, true, NOW()) 
      RETURNING *
    `, [conversation_id, senderId, encryptedContent, staticDecoy, message_type, destructionTimer]);
    const message = result.rows[0];

    await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation_id]);

    // **THE FIX**: Instead of 'new_message', we emit a new 'finalize_message' event.
    // This tells the client to perform the shimmer transition.
    const messageData = {
      id: message.id,
      conversation_id: message.conversation_id,
      sender_id: message.sender_id,
      content: message.decoy_content, // This is the Static Decoy (Decoy B)
      message_type: message.message_type,
      is_encrypted_display: true,
      is_decrypted: false,
      is_seen: false,
      self_destruct_timer: message.self_destruct_timer,
      created_at: message.created_at,
      expires_at: message.expires_at,
    };

    io.to(`conversation_${conversation_id}`).emit('sync_transient', messageData);
    console.log(`💬 Message ${message.id} finalized and sent to conversation ${conversation_id}`);

  } catch (error) {
    console.error('Send message error:', error);
    socket.emit('error', { message: 'Failed to send message' });
  }
});

    // Handle decryption request (revolutionary feature)
   socket.on('invoke_sync', async (data) => {
  try {
    const { message_id } = data;
    const requesterId = socket.user.id;

    const messageResult = await pool.query('SELECT * FROM messages WHERE id = $1', [message_id]);
    if (messageResult.rows.length === 0) {
      return socket.emit('error', { message: 'Message not found' });
    }
    const message = messageResult.rows[0];

    if (message.sender_id === requesterId) {
      return socket.emit('error', { message: 'Cannot request decryption of your own message' });
    }
if (await verifyChannelIntegrity(requesterId, message.sender_id)) {
    return socket.emit('error', { message: 'Cannot request decryption from a blocked user.' });
}
    // Create decryption request, now including conversation_id
    const requestResult = await pool.query(`
      INSERT INTO decryption_requests (message_id, requester_id, sender_id, conversation_id, status)
      VALUES ($1, $2, $3, $4, 'pending') 
      RETURNING *
    `, [message_id, requesterId, message.sender_id, message.conversation_id]);
    const request = requestResult.rows[0];

    // Notify sender
    io.to(`user_${message.sender_id}`).emit('invoke_sync', {
      ...request, // Send the full request object
      requester_username: socket.user.username,
    });

    console.log(`🔓 Decryption requested for message ${message_id}`);
  } catch (error) {
    console.error('Request decryption error:', error);
    socket.emit('error', { message: 'Failed to request decryption' });
  }
});

    // Handle sender providing decryption key (revolutionary feature)
    socket.on('provide_decryption_key', async (data) => {
      try {
        const { request_id, decryption_key, approve = true } = data;
        const senderId = socket.user.id;

        // Get decryption request
        const requestResult = await pool.query(
          'SELECT * FROM decryption_requests WHERE id = $1 AND sender_id = $2',
          [request_id, senderId]
        );

        if (requestResult.rows.length === 0) {
          socket.emit('error', { message: 'Decryption request not found' });
          return;
        }

        const request = requestResult.rows[0];

        if (!approve) {
          // Deny decryption request
          await pool.query(
            'UPDATE decryption_requests SET status = $1, resolved_at = NOW() WHERE id = $2',
            ['denied', request_id]
          );

          io.to(`user_${request.requester_id}`).emit('decryption_denied', {
            message_id: request.message_id,
            message: 'Sender denied decryption request'
          });

          socket.emit('decryption_response_sent', { message: 'Decryption request denied' });
          return;
        }

        // Get message to decrypt
        const messageResult = await pool.query(
          'SELECT * FROM messages WHERE id = $1',
          [request.message_id]
        );

        const message = messageResult.rows[0];

        // Try to decrypt with provided key
        const decryptedContent = resolveWithProof(message.content, decryption_key);

        // Update message as decrypted
        await pool.query(
          'UPDATE messages SET is_decrypted = true, decryption_key = $1 WHERE id = $2',
          [decryption_key, request.message_id]
        );

        // Update request as approved
        await pool.query(
          'UPDATE decryption_requests SET status = $1, resolved_at = NOW() WHERE id = $2',
          ['approved', request_id]
        );

        // Send decrypted message to requester with self-destruction
        io.to(`user_${request.requester_id}`).emit('message_decrypted', {
          message_id: request.message_id,
          content: decryptedContent,
          self_destruct_timer: message.self_destruct_timer,
          decrypted_at: new Date()
        });

        // Confirm to sender
        socket.emit('decryption_response_sent', {
          message: 'Message decrypted for requester'
        });

        console.log(`🔑 Message ${request.message_id} decrypted successfully`);

      } catch (error) {
        console.error('Provide decryption key error:', error);
        socket.emit('error', { 
          message: error.message.includes('Invalid decryption key') ? 
                   'Invalid decryption key' : 'Failed to decrypt message' 
        });
      }
    });

    // === DEFINITIVE REPLACEMENT for view_once_completed ===
socket.on('view_once_completed', async (data) => {
    const { message_id } = data;
    const userId = socket.user.id; // Get the user who triggered the completion

    try {
        // 1. Get the message details BEFORE deleting it
        const result = await pool.query(
            'SELECT file_metadata, conversation_id FROM messages WHERE id = $1',
            [message_id]
        );

        if (result.rows.length > 0) {
            const message = result.rows[0];
            const filePath = message.file_metadata.path;

            // 2. Delete the message record from the database
            await pool.query('DELETE FROM messages WHERE id = $1', [message_id]);

            // 3. Delete the actual file from the server's disk
            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error(`Failed to delete file ${filePath}:`, err);
                } else {
                    console.log(`🗑️ View Once file ${filePath} permanently deleted by user ${userId}.`);
                }
            });

            // 4. **THE FIX**: Notify all clients in the conversation to remove the message from their UI.
            // This provides the "zero trace" real-time vanishing effect.
            io.to(`conversation_${message.conversation_id}`).emit('item_removed', { 
                message_id: message_id,
                conversation_id: message.conversation_id
            });
        }
    } catch (error) {
        console.error('View once completion error:', error);
    }
});

    // Handle message seen (read receipt)
    socket.on('message_seen', async (data) => {
      try {
        const { message_id } = data;
        const viewerId = socket.user.id;

        // Update message as seen
        const result = await pool.query(
          'UPDATE messages SET is_seen = true WHERE id = $1 AND sender_id != $2 RETURNING sender_id',
          [message_id, viewerId]
        );

        if (result.rows.length > 0) {
          const senderId = result.rows[0].sender_id;
          
          // Notify sender that message was seen
          io.to(`user_${senderId}`).emit('message_seen_update', {
            message_id: message_id,
            seen_by: socket.user.username,
            seen_at: new Date()
          });

          console.log(`👀 Message ${message_id} seen by ${socket.user.username}`);
        }

      } catch (error) {
        console.error('Message seen error:', error);
      }
    });

    // Handle inline decryption request
   socket.on('inline_decryption_request', async (data) => {
  try {
    const { message_id, sender_id } = data;
    const requesterId = socket.user.id;

    const messageResult = await pool.query('SELECT * FROM messages WHERE id = $1 AND sender_id = $2', [message_id, sender_id]);
    if (messageResult.rows.length === 0) {
      return socket.emit('error', { message: 'Message not found for this request.' });
    }
    const message = messageResult.rows[0];

    if (message.sender_id === requesterId) {
      return socket.emit('error', { message: 'Cannot request decryption of your own message' });
    }

    // Attempt to save the request to the database for persistence.
    // ON CONFLICT will safely ignore duplicates.
    await pool.query(`
      INSERT INTO decryption_requests (message_id, requester_id, sender_id, conversation_id, status)
      VALUES ($1, $2, $3, $4, 'pending')
      ON CONFLICT (message_id, requester_id) DO NOTHING
    `, [message_id, requesterId, message.sender_id, message.conversation_id]);
    
    // **THE FIX**: Always emit the real-time event to the sender, regardless of DB result.
    // We fetch the latest request info to ensure the payload is complete.
    const latestRequestInfo = await pool.query(
        'SELECT * FROM decryption_requests WHERE message_id = $1 AND requester_id = $2',
        [message_id, requesterId]
    );

    if (latestRequestInfo.rows.length > 0) {
        const requestPayload = {
            ...latestRequestInfo.rows[0],
            requester_username: socket.user.username
        };
        io.to(`user_${sender_id}`).emit('decryption_request', requestPayload);
        console.log(`📡 Real-time decryption request for message ${message_id} sent to sender.`);
    }

  } catch (error) {
    console.error('Inline decryption request error:', error);
    socket.emit('error', { message: 'Failed to request decryption' });
  }
});

    // Handle inline decryption key provision
// STEP 1: Sender provides THEIR key, which we verify and temporarily store.
socket.on('submit_source_proof', async (data) => {
    try {
        const { message_id, decryption_key } = data;
        const senderId = socket.user.id;

        const messageResult = await pool.query('SELECT * FROM messages WHERE id = $1 AND sender_id = $2', [message_id, senderId]);
        if (messageResult.rows.length === 0) {
            return socket.emit('error', { message: 'Message not found or you are not authorized.' });
        }
        
        const message = messageResult.rows[0];

        // We MUST verify the sender's key is correct by actually trying to decrypt.
        try {
            resolveWithProof(message.content, decryption_key);
        } catch (e) {
            console.log(`User ${senderId} provided an invalid key for message ${message_id}`);
            return socket.emit('error', { message: 'Invalid decryption key provided.' });
        }

        // Key is valid. Store it securely in our temporary table.
        await pool.query(
            'INSERT INTO approved_decryptions (message_id, sender_key) VALUES ($1, $2) ON CONFLICT (message_id) DO UPDATE SET sender_key = EXCLUDED.sender_key',
            [message_id, decryption_key]
        );

        // Now, broadcast that the sender has approved.
        io.to(`conversation_${message.conversation_id}`).emit('sender_approved_decryption', {
            message_id: message_id,
            sender_id: senderId
        });
        console.log(`Sender ${senderId} approved decryption for message ${message_id}. Key stored temporarily.`);

    } catch (error) {
        console.error('Sender provide key error:', error);
        socket.emit('error', { message: 'Failed to process sender key' });
    }
});

// STEP 2: Receiver provides THEIR key, which we verify before triggering final decryption.
// === DEFINITIVE REPLACEMENT for receiver_provide_key ===
socket.on('submit_target_proof', async (data) => {
    try {
        const { message_id, decryption_key } = data;
        const receiverId = socket.user.id;
        
        const messageResult = await pool.query('SELECT * FROM messages WHERE id = $1', [message_id]);
        if (messageResult.rows.length === 0) return socket.emit('error', { message: 'Message not found.' });
        const message = messageResult.rows[0];

        const convKeyResult = await pool.query('SELECT decryption_key_hash FROM conversation_keys WHERE conversation_id = $1 AND user_id = $2', [message.conversation_id, receiverId]);
        if (convKeyResult.rows.length === 0) return socket.emit('error', { message: 'You have not set a Personal Decryption Key.' });
        const { decryption_key_hash } = convKeyResult.rows[0];
        const isKeyValid = await bcrypt.compare(decryption_key, decryption_key_hash);
        if (!isKeyValid) return socket.emit('error', { message: 'Invalid Personal Decryption Key.' });

        const approvedKeyResult = await pool.query('SELECT sender_key FROM approved_decryptions WHERE message_id = $1', [message_id]);
        if (approvedKeyResult.rows.length === 0) return socket.emit('error', { message: 'Sender has not approved this decryption yet.' });
        const senderKey = approvedKeyResult.rows[0].sender_key;

        const decryptedContent = resolveWithProof(message.content, senderKey);

        if (message.message_type === 'text') {
            const updateResult = await pool.query(
              `UPDATE messages SET is_decrypted = true, is_encrypted_display = false, content = $1, expires_at = NOW() + (COALESCE(self_destruct_timer, 60) * INTERVAL '1 second') WHERE id = $2 RETURNING expires_at`,
              [decryptedContent, message_id]
            );
            io.to(`conversation_${message.conversation_id}`).emit('initiate_sync', {
              message_id: message_id,
              decoy_content: message.decoy_content,
              real_content: decryptedContent,
              self_destruct_timer: message.self_destruct_timer,
              expires_at: updateResult.rows[0].expires_at
            });
        } else if (message.message_type === 'file') {
            const decryptedMetadata = JSON.parse(decryptedContent);
            const singleUseToken = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

            // **THE FIX**: Store the sender's key WITH the download token.
            await pool.query(
                'INSERT INTO download_tokens (token, message_id, user_id, expires_at, sender_key) VALUES ($1, $2, $3, $4, $5)',
                [singleUseToken, message_id, receiverId, expiresAt, senderKey]
            );

            await pool.query('UPDATE messages SET is_decrypted = true WHERE id = $1', [message_id]);

            io.to(`conversation_${message.conversation_id}`).emit('file_hydrated_successfully', {
                message_id: message_id,
                decrypted_metadata: decryptedMetadata,
                download_token: singleUseToken
            });
        }
        
        // Now it is safe to delete the approval record.
        await pool.query('DELETE FROM approved_decryptions WHERE message_id = $1', [message_id]);
        console.log(`🔑 Message ${message_id} decrypted by ${receiverId}. Approval key moved to token.`);
    } catch (error) {
         console.error('Receiver provide key error:', error);
         socket.emit('error', { message: 'Failed to process receiver key.' });
    }
});

    // Handle delete message
    socket.on('item_removed', async (data) => {
  try {
    const { message_id } = data;
    const userId = socket.user.id;

    const messageResult = await pool.query('SELECT * FROM messages WHERE id = $1', [message_id]);
    if (messageResult.rows.length === 0) {
      return socket.emit('error', { message: 'Message not found.' });
    }
    const message = messageResult.rows[0];

    // SENDER: Deletes for everyone.
    if (message.sender_id === userId) {
      await pool.query('DELETE FROM messages WHERE id = $1', [message_id]);
      io.to(`conversation_${message.conversation_id}`).emit('item_removed', {
        message_id: message_id,
        conversation_id: message.conversation_id
      });
      console.log(`🗑️ Message ${message_id} deleted for everyone by sender ${userId}`);
    } 
    // RECEIVER: Deletes only for themselves.
    else {
      await pool.query(
        'INSERT INTO user_message_deletions (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, message_id]
      );
      // Notify only the user who deleted it
      socket.emit('item_removed', {
        message_id: message_id,
        conversation_id: message.conversation_id
      });
      console.log(`🗑️ Message ${message_id} deleted for receiver ${userId}`);
    }
  } catch (error) {
    console.error('Delete message error:', error);
    socket.emit('error', { message: 'Failed to delete message' });
  }
});
    // Handle typing indicators
    socket.on('typing', (data) => {
      const { conversation_id, is_typing } = data;
      socket.to(`conversation_${conversation_id}`).emit('user_typing', {
        user_id: socket.user.id,
        username: socket.user.username,
        is_typing
      });
    });

    // Handle message self-destruction
    socket.on('item_gc', async (data) => {
      try {
        const { message_id } = data;

        // Mark message as destroyed
        await pool.query(
          'UPDATE messages SET destroyed_at = NOW() WHERE id = $1',
          [message_id]
        );

        console.log(`💥 Message ${message_id} self-destructed`);

      } catch (error) {
        console.error('Self-destruct error:', error);
      }
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
      console.log(`❌ User disconnected: ${socket.user.username}`);
      await handleDisconnect(socket.user.id);
    });
  });

  // Helper function to join user to their conversation rooms
  const joinUserConversations = async (socket) => {
    try {
      const result = await pool.query(`
        SELECT DISTINCT c.id
        FROM conversations c
        JOIN conversation_participants cp ON c.id = cp.conversation_id
        WHERE cp.user_id = $1
      `, [socket.user.id]);

      result.rows.forEach(row => {
        socket.join(`conversation_${row.id}`);
      });

    } catch (error) {
      console.error('Join conversations error:', error);
    }
  };

  console.log('🚀 Revolutionary Socket.IO service initialized');
}

module.exports = {
  initializeSocket
};
