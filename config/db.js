const mysql = require('mysql');

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'Sunita#11mali',
  database: 'maindatabase'
});

db.connect((err) => {
  if (err) {
    console.error('Database connection failed:', err.stack);
    return;
  }
  console.log('Connected to database.');

  const createAdminsTable = `
    CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_name VARCHAR(255) NOT NULL,
      doctor_name VARCHAR(255) NOT NULL,
      doctor_degree VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      license_number VARCHAR(100) NOT NULL UNIQUE,
      avg_time_per_patient INT NOT NULL,
      location VARCHAR(255) NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  db.query(createAdminsTable, (err) => {
    if (err) console.error('Error creating admins table:', err);
    else console.log('Admins table created or already exists.');
  });

  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      first_name VARCHAR(255) NOT NULL,
      last_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      gender VARCHAR(50),
      phone_number VARCHAR(20),
      dob DATE,
      location VARCHAR(255),
      photo VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  db.query(createUsersTable, (err) => {
    if (err) console.error('Error creating users table:', err);
    else console.log('Users table created or already exists.');
  });

  const createAppointmentsTable = `
    CREATE TABLE IF NOT EXISTS appointments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      first_name VARCHAR(255) NOT NULL,
      last_name VARCHAR(255) NOT NULL,
      gender VARCHAR(50),
      phone_number VARCHAR(20),
      age INT,
      location VARCHAR(255),
      appointment_date DATE NOT NULL,
      appointment_time TIME NOT NULL,
      admin_id INT DEFAULT NULL,
      weight INT,
      status ENUM('pending', 'ongoing', 'completed', 'cancelled') DEFAULT 'pending',
      token_number INT,
      prescription TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
    )
  `;
  db.query(createAppointmentsTable, (err) => {
    if (err) console.error('Error creating appointments table:', err);
    else console.log('Appointments table created or already exists.');
  });

  const createMedicinesTable = `
    CREATE TABLE IF NOT EXISTS medicines (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      dosage VARCHAR(100),
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  db.query(createMedicinesTable, (err) => {
    if (err) console.error('Error creating medicines table:', err);
    else console.log('Medicines table created or already exists.');
  });
});

function searchPatientsByName(adminId, query, callback) {
  const searchQuery = `%${query}%`;
  const queryText = `
    SELECT DISTINCT a.id, a.first_name, a.last_name, a.phone_number, a.gender, a.age, a.location,
                    a.appointment_date, a.appointment_time, a.token_number, a.status, a.prescription
    FROM appointments a
    JOIN admins ad ON a.admin_id = ad.id
    WHERE ad.id = ? AND (a.first_name LIKE ? OR a.last_name LIKE ? OR CONCAT(a.first_name, ' ', a.last_name) LIKE ?)
  `;
  db.query(queryText, [adminId, searchQuery, searchQuery, searchQuery], (err, results) => {
    if (err) {
      console.error('Error searching patients:', err);
      return callback(err, null);
    }
    callback(null, results);
  });
}

module.exports = db;
module.exports.searchPatientsByName = searchPatientsByName;