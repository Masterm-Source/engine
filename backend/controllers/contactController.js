const { Pool } = require('pg');

const pool = require('../database/database');

// Get user's contact list
const getContacts = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(`
      SELECT 
        c.id as contact_id,
        c.nickname,
        c.added_at,
        u.id as user_id,
        u.username,
        u.bio,
        u.is_online,
        u.last_seen,
        -- THIS IS THE NEW PART --
        CASE WHEN b.id IS NOT NULL THEN true ELSE false END as is_blocked
      FROM contacts c
      JOIN users u ON c.contact_id = u.id
      -- This LEFT JOIN checks if the current user has blocked this contact
      LEFT JOIN blocked_users b ON b.blocker_id = $1 AND b.blocked_id = c.contact_id
      WHERE c.user_id = $1
      ORDER BY u.username ASC
    `, [userId]);

    res.json({
      success: true,
      contacts: result.rows
    });

  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};
// Search for users to add as contacts
const searchUsers = async (req, res) => {
  try {
    const { query } = req.query;
    const userId = req.user.id;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const result = await pool.query(`
      SELECT 
        u.id,
        u.username,
        u.bio,
        u.profile_photo,
        u.is_online,
        u.last_seen,
        CASE WHEN c.id IS NOT NULL THEN true ELSE false END as is_contact
      FROM users u
      LEFT JOIN contacts c ON c.contact_id = u.id AND c.user_id = $1
      WHERE u.username ILIKE $2 AND u.id != $1
      ORDER BY u.is_online DESC, u.username
      LIMIT 20
    `, [userId, `%${query}%`]);

    res.json({
      success: true,
      users: result.rows
    });

  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
};

// Add a contact
const addContact = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contact_id, nickname } = req.body;

    if (!contact_id) {
      return res.status(400).json({ error: 'Contact ID required' });
    }

    if (contact_id == userId) {
      return res.status(400).json({ error: 'Cannot add yourself as contact' });
    }

    // Check if contact exists
    const userCheck = await pool.query(
      'SELECT id, username FROM users WHERE id = $1',
      [contact_id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if already a contact
    const existingContact = await pool.query(
      'SELECT id FROM contacts WHERE user_id = $1 AND contact_id = $2',
      [userId, contact_id]
    );

    if (existingContact.rows.length > 0) {
      return res.status(400).json({ error: 'Already in contacts' });
    }

    // Add contact
    const result = await pool.query(
      'INSERT INTO contacts (user_id, contact_id, nickname) VALUES ($1, $2, $3) RETURNING *',
      [userId, contact_id, nickname || userCheck.rows[0].username]
    );

    // Get contact details
    const contactDetails = await pool.query(`
      SELECT 
        c.id as contact_id,
        c.nickname,
        c.added_at,
        u.id as user_id,
        u.username,
        u.bio,
        u.profile_photo,
        u.is_online,
        u.last_seen
      FROM contacts c
      JOIN users u ON c.contact_id = u.id
      WHERE c.id = $1
    `, [result.rows[0].id]);

    res.status(201).json({
      success: true,
      message: 'Contact added successfully',
      contact: contactDetails.rows[0]
    });

  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
};


// Update contact nickname
const updateContactNickname = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;
    const { nickname } = req.body;

    if (!nickname || nickname.trim().length === 0) {
      return res.status(400).json({ error: 'Nickname required' });
    }

    const result = await pool.query(
      'UPDATE contacts SET nickname = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [nickname.trim(), contactId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({
      success: true,
      message: 'Nickname updated successfully',
      contact: result.rows[0]
    });

  } catch (error) {
    console.error('Update nickname error:', error);
    res.status(500).json({ error: 'Failed to update nickname' });
  }
};

// (This should be inside contactController.js)
const removeContact = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;

    // Start a database transaction to ensure all or no deletions happen
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Find the direct, 1-on-1 conversation ID between the two users
      const conversationRes = await client.query(`
        SELECT cp1.conversation_id FROM conversation_participants AS cp1
        INNER JOIN conversation_participants AS cp2 ON cp1.conversation_id = cp2.conversation_id
        WHERE cp1.user_id = $1 AND cp2.user_id = $2 AND (
          SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = cp1.conversation_id
        ) = 2
      `, [userId, contactId]);

      if (conversationRes.rows.length > 0) {
        const conversationId = conversationRes.rows[0].conversation_id;
        
        // This is a safer deletion order for a complex schema.
        // We delete all records referencing the conversation before deleting the conversation itself.
        await client.query('DELETE FROM decryption_requests WHERE conversation_id = $1', [conversationId]);
        await client.query('DELETE FROM user_message_deletions WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)', [conversationId]);
        await client.query('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
        await client.query('DELETE FROM conversation_participants WHERE conversation_id = $1', [conversationId]);
        await client.query('DELETE FROM conversation_keys WHERE conversation_id = $1', [conversationId]);
        await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      }
      
      // Finally, remove the contact relationship for both users
      await client.query('DELETE FROM contacts WHERE (user_id = $1 AND contact_id = $2) OR (user_id = $2 AND contact_id = $1)', [userId, contactId]);
      
      await client.query('COMMIT');
      res.status(200).json({ success: true, message: 'Contact and associated conversation deleted successfully' });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e; // Propagate error to the outer catch block
    } finally {
      client.release(); // Release the client back to the pool
    }
  } catch (error) {
    console.error('Remove contact error:', error);
    res.status(500).json({ error: 'Failed to remove contact' });
  }
};

const blockUser = async (req, res) => {
  try {
    const blockerId = req.user.id;
    const { blockedId, isBlocked } = req.body;

    if (isBlocked) {
      // Add a block record. If it's already there, do nothing.
      await pool.query(
        'INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT (blocker_id, blocked_id) DO NOTHING',
        [blockerId, blockedId]
      );
      res.status(200).json({ success: true, message: 'User blocked successfully' });
    } else {
      // Remove the block record.
      await pool.query(
        'DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
        [blockerId, blockedId]
      );
      res.status(200).json({ success: true, message: 'User unblocked successfully' });
    }
  } catch (error) {
    // This will now only trigger if the table truly doesn't exist or another DB error occurs.
    console.error('Block user error:', error);
    res.status(500).json({ error: 'Failed to update block status' });
  }
};

module.exports = {
  getContacts,
  searchUsers,
  addContact,
  removeContact,
  updateContactNickname,
  blockUser,
};
