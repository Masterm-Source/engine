const jwt = require('jsonwebtoken');

// Use the central, environment-aware database configuration
const pool = require('../database/database.js');
// Proactive check to ensure JWT_SECRET is loaded from .env
if (!process.env.JWT_SECRET) {
    console.error("FATAL ERROR: JWT_SECRET is not defined in .env file.");
    process.exit(1); // Exit the application with a failure code
}

// JWT authentication middleware for HTTP routes
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get fresh user data from database
    const result = await pool.query(
      'SELECT id, username, bio, profile_photo, is_online FROM users WHERE id = $1',
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    next();

  } catch (error) {
    console.error('Authentication error:', error);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({ error: 'Token expired' });
    }
    
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// Socket.IO authentication middleware
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get fresh user data
    const result = await pool.query(
      'SELECT id, username, bio, profile_photo, is_online FROM users WHERE id = $1',
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return next(new Error('User not found'));
    }

    // Set user online status
    await pool.query(
      'UPDATE users SET is_online = true, last_seen = NOW() WHERE id = $1',
      [decoded.id]
    );

    socket.user = result.rows[0];
    next();

  } catch (error) {
    console.error('Socket authentication error:', error);
    
    if (error.name === 'JsonWebTokenError') {
      return next(new Error('Invalid token'));
    }
    if (error.name === 'TokenExpiredError') {
      return next(new Error('Token expired'));
    }
    
    next(new Error('Authentication failed'));
  }
};

// Handle user disconnect (set offline)
const handleDisconnect = async (userId) => {
  try {
    await pool.query(
      'UPDATE users SET is_online = false, last_seen = NOW() WHERE id = $1',
      [userId]
    );
    console.log(`User ${userId} set to offline`);
  } catch (error) {
    console.error('Disconnect handler error:', error);
  }
};

module.exports = {
  authenticateToken,
  authenticateSocket,
  handleDisconnect
};
