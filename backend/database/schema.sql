-- Vanish Revolutionary Database Schema
-- Supports profiles, contacts, conversations, sender-controlled decryption

-- Drop existing tables if they exist (careful!)
DROP TABLE IF EXISTS decryption_requests CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversation_participants CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS contacts CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Users table with profiles and crypto keys
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    public_key TEXT,
    profile_photo TEXT,
    bio TEXT DEFAULT 'Hey there! I am using Vanish.',
    last_seen TIMESTAMP DEFAULT NOW(),
    is_online BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Contacts/Friends system
CREATE TABLE contacts (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    contact_id INT REFERENCES users(id) ON DELETE CASCADE,
    nickname VARCHAR(100),
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, contact_id)
);

-- Conversations (direct and group)
CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    type VARCHAR(20) DEFAULT 'direct',
    name VARCHAR(100),
    created_by INT REFERENCES users(id) ON DELETE SET NULL,
    last_message_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Conversation participants
CREATE TABLE conversation_participants (
    id SERIAL PRIMARY KEY,
    conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(conversation_id, user_id)
);

-- Revolutionary messages with sender-controlled decryption AND all enhanced features
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INT REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text',
    encryption_method VARCHAR(50) DEFAULT 'sender_controlled',
    sender_key_hint VARCHAR(100),
    is_decrypted BOOLEAN DEFAULT false,
    decryption_key VARCHAR(255),
    self_destruct_timer INT DEFAULT 60,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    destroyed_at TIMESTAMP,
    -- Enhanced features columns
    decoy_content TEXT,
    is_encrypted_display BOOLEAN DEFAULT true,
    is_seen BOOLEAN DEFAULT false,
    deleted_at TIMESTAMP,
    deleted_by INTEGER REFERENCES users(id)
);

-- Decryption requests (revolutionary feature)
CREATE TABLE decryption_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id INT REFERENCES messages(id) ON DELETE CASCADE,
    requester_id INT REFERENCES users(id) ON DELETE CASCADE,
    sender_id INT REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    requested_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_messages_seen ON messages(is_seen);
CREATE INDEX IF NOT EXISTS idx_messages_encrypted_display ON messages(is_encrypted_display);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_participants ON conversation_participants(conversation_id, user_id);

-- Insert sample data for testing
INSERT INTO users (username, password_hash, bio) VALUES 
('testuser1', '$2b$10$example1', 'Revolutionary user 1'),
('testuser2', '$2b$10$example2', 'Revolutionary user 2');

-- Success message
SELECT 'Vanish Revolutionary Schema Created Successfully!' as status;
