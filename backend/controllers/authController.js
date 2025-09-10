const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// Proactive check to ensure JWT_SECRET is loaded from .env
if (!process.env.JWT_SECRET) {
    console.error("FATAL ERROR: JWT_SECRET is not defined in .env file.");
    process.exit(1); // Exit the application with a failure code
}

const pool = require('../database/database.js');

// Register user with profile support
const register = async (req, res) => {
  try {
    // The email field has been removed from here.
    const { username, password, bio } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // 1. Check for unique username
    const existingUser = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    
    // 2. The email check has been completely removed.

    // 3. Enforce strong password requirements
    const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{7,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({ 
        error: 'Password must be at least 7 characters long and include at least one letter, one number, and one special character.' 
      });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // The SQL INSERT statement no longer includes the email column.
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, bio) VALUES ($1, $2, $3) RETURNING id, username, bio',
      [username, passwordHash, bio]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: user.id,
        username: user.username,
        bio: user.bio
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
};

// Login with profile data
const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Get user from database
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      // THIS IS THE FIX: Specific error for user not found
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      // THIS IS THE FIX: Specific error for incorrect password
      return res.status(401).json({ error: 'Incorrect password' });
    }

    // Update last seen and online status
    await pool.query(
      'UPDATE users SET last_seen = NOW(), is_online = true WHERE id = $1',
      [user.id]
    );

   // Generate JWT token
   const token = jwt.sign(
     { id: user.id, username: user.username },
     process.env.JWT_SECRET,
     { expiresIn: '24h' }
   );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        bio: user.bio,
        profile_photo: user.profile_photo,
        last_seen: user.last_seen,
        created_at: user.created_at
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
};

// Get user profile
const getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      'SELECT id, username, bio, profile_photo, last_seen, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

// Update user profile
const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { bio, profile_photo } = req.body;

    const result = await pool.query(
      'UPDATE users SET bio = COALESCE($1, bio), profile_photo = COALESCE($2, profile_photo) WHERE id = $3 RETURNING id, username, bio, profile_photo',
      [bio, profile_photo, userId]
    );

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
};

module.exports = {
  register,
  login,
  getProfile,
  updateProfile
};
