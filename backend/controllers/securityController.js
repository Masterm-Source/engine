const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = require('../database/database.js');

// --- HELPER FUNCTION ---

const generateVerificationCode = () => {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
};

// This new function verifies the user's main account password.
const verifyUserPassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password is required for verification.' });
    }

    const result = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = result.rows[0];

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    res.status(200).json({ success: true, message: 'Password verified successfully.' });

  } catch (error) {
    console.error('Password verification error:', error);
    res.status(500).json({ error: 'Server error during password verification.' });
  }
};

// Step 3: Set the new conversation key after successful verification.
const finalizeKeyChange = async (req, res) => {
    const { conversationId, newKey } = req.body;
    const userId = req.user.id;

    if (!conversationId || !newKey) {
        return res.status(400).json({ error: 'Conversation ID and new key are required.' });
    }
    if (newKey.length < 4) {
        return res.status(400).json({ error: 'Key must be at least 4 characters long.' });
    }

    try {
        // SECURITY FIX: The new key is now securely hashed before saving.
        const keyHash = await bcrypt.hash(newKey, 10);

        const query = `
            INSERT INTO conversation_keys (user_id, conversation_id, decryption_key_hash)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, conversation_id)
            DO UPDATE SET decryption_key_hash = EXCLUDED.decryption_key_hash, updated_at = NOW();
        `;

        await pool.query(query, [userId, conversationId, keyHash]);

        res.status(200).json({ success: true, message: 'Conversation key updated successfully.' });

    } catch (error) {
        console.error('Finalize key change error:', error);
        res.status(500).json({ error: 'Server error while finalizing key change.' });
    }
};

// This is the function for the "Save Key" button in the chat header.
const setConversationKey = async (req, res) => {
    const userId = req.user.id;
    const { conversationId, key } = req.body;

    if (!conversationId || !key) {
        return res.status(400).json({ error: 'Conversation ID and key are required' });
    }

    try {
        const participantCheck = await pool.query(
            'SELECT 1 FROM conversation_participants WHERE user_id = $1 AND conversation_id = $2',
            [userId, conversationId]
        );

        if (participantCheck.rows.length === 0) {
            return res.status(403).json({ error: 'You are not a participant in this conversation.' });
        }

        // The key is always securely hashed before saving.
        const salt = await bcrypt.genSalt(10);
        const keyHash = await bcrypt.hash(key, salt);

        await pool.query(
            `INSERT INTO conversation_keys (user_id, conversation_id, decryption_key_hash, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, conversation_id)
             DO UPDATE SET decryption_key_hash = EXCLUDED.decryption_key_hash, updated_at = NOW()`,
            [userId, conversationId, keyHash]
        );

        res.status(200).json({ success: true, message: 'Conversation key saved securely.' });

    } catch (error) {
        console.error('Set conversation key error:', error);
        res.status(500).json({ error: 'Failed to save conversation key' });
    }
};

// Check if a user has already set a key for a specific conversation
const checkConversationKey = async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const result = await pool.query(
      'SELECT 1 FROM conversation_keys WHERE user_id = $1 AND conversation_id = $2',
      [userId, conversationId]
    );

    // If a row is found, it means a key has been saved.
    const hasKey = result.rows.length > 0;

    res.status(200).json({ hasKey });

  } catch (error) {
    console.error('Check conversation key error:', error);
    res.status(500).json({ error: 'Failed to check key status' });
  }
};

// --- EXPORTS ---

// All functions are now exported from this single, consistent block.
module.exports = {
  finalizeKeyChange,
  setConversationKey,
  checkConversationKey, // Add the new function here
  verifyUserPassword
};
