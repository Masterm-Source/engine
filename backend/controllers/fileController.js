// === DEFINITIVE REPLACEMENT for fileController.js ===
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const pool = require('../database/database.js');

const decryptMessage = (encryptedContent, senderKey) => {
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
    console.error("Decryption failed in file controller:", error);
    throw new Error('Invalid decryption key');
  }
};

exports.downloadFile = async (req, res) => {
    const { messageId } = req.params;
    const { token } = req.query;

    if (!token) {
        return res.status(403).json({ error: 'A valid download token is required.' });
    }

    try {
        // **THE FIX**: Get the sender_key from the token record itself.
        const tokenResult = await pool.query(
            'SELECT sender_key FROM download_tokens WHERE token = $1 AND message_id = $2 AND expires_at > NOW()',
            [token, messageId]
        );

        if (tokenResult.rows.length === 0) {
            return res.status(403).json({ error: 'Invalid, expired, or unauthorized download token.' });
        }
        const senderKey = tokenResult.rows[0].sender_key;

        const messageResult = await pool.query(
            'SELECT content, file_metadata FROM messages WHERE id = $1',
            [messageId]
        );

        if (messageResult.rows.length === 0) {
             await pool.query('DELETE FROM download_tokens WHERE token = $1', [token]);
             return res.status(404).json({ error: 'File data not found.' });
        }

        const message = messageResult.rows[0];
        const decryptedContent = decryptMessage(message.content, senderKey);
        const decryptedMetadata = JSON.parse(decryptedContent);
        
        const filePath = path.join(__dirname, '..', message.file_metadata.path);
        
        // Use res.download, which is robust for sending files.
        res.download(filePath, decryptedMetadata.originalName, async (err) => {
            if (err) {
                console.error("Error sending file:", err);
                // Don't send another response if headers were already sent
                if (!res.headersSent) {
                   res.status(500).send("Could not download the file.");
                }
            }
            // **ROBUSTNESS**: Only delete the token after a successful download attempt.
            await pool.query('DELETE FROM download_tokens WHERE token = $1', [token]);
        });

    } catch (error) {
        console.error('File download error:', error);
        if (!res.headersSent) {
           res.status(500).json({ error: 'Failed to download file.' });
        }
    }
};
