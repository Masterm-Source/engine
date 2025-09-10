require('dotenv').config();
const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

let pool;

if (isProduction) {
  // Production configuration (for Render)
  // This uses the single DATABASE_URL provided by the hosting service.
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
} else {
  // Development configuration (for your local machine)
  // This reads the separate variables from your .env file.
  pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
  });
}

module.exports = {
  query: (text, params) => pool.query(text, params),
};
