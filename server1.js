const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const bcrypt = require('bcrypt');
const session = require('express-session');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const axios = require('axios'); // For medicine API calls

const app = express();
const port = process.env.PORT || 5001;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
  secret: 'nil@123',
  resave: false,
  saveUninitialized: true,
}));

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'nil@123456789',
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
    if (err) {
      console.error('Error creating admins table:', err);
    } else {
      console.log('Admins table created or already exists.');
    }
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
      doctor_name VARCHAR(255) NOT NULL,
      status ENUM('pending', 'completed', 'cancelled') DEFAULT 'pending',
      token_number VARCHAR(50),
      prescription TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  db.query(createAppointmentsTable, (err) => {
    if (err) {
      console.error('Error creating appointments table:', err);
    } else {
      console.log('Appointments table created or already exists.');
    }
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
});
});

// Admin Profile Endpoints
app.get('/admin/profile', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const adminId = req.session.adminId;
  const query = `SELECT * FROM admins WHERE id = ?`;
  db.query(query, [adminId], (err, results) => {
    if (err) {
      console.error('Error fetching admin profile:', err);
      return res.status(500).json({ success: false, message: 'Error fetching admin profile' });
    }

    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    const admin = results[0];
    delete admin.password;
    res.status(200).json({ success: true, admin });
  });
});

// Update the /admin/update-profile endpoint
app.post('/admin/update-profile', async (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const adminId = req.session.adminId;
  const {
    hospital_name,
    doctor_name,
    doctor_degree,
    email,
    license_number,
    avg_time_per_patient,
    location,
    password
  } = req.body;

  // First get current admin details
  const getAdminQuery = `SELECT * FROM admins WHERE id = ?`;
  db.query(getAdminQuery, [adminId], async (err, adminResults) => {
    if (err || adminResults.length === 0) {
      return res.status(500).json({ success: false, message: 'Error fetching admin details' });
    }

    const currentAdmin = adminResults[0];
    const currentDoctorName = currentAdmin.doctor_name;
    const newDoctorName = doctor_name;

    try {
      let updateFields = {
        hospital_name,
        doctor_name,
        doctor_degree,
        email,
        license_number,
        avg_time_per_patient,
        location
      };

      if (password) {
        const hashedPassword = await bcrypt.hash(password, 10);
        updateFields.password = hashedPassword;
      }

      const updateQuery = `UPDATE admins SET ? WHERE id = ?`;
      db.query(updateQuery, [updateFields, adminId], (err, result) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'Error updating admin profile' });
        }

        // If doctor name changed, update references in appointments table
        if (currentDoctorName !== newDoctorName) {
          const updateAppointmentsQuery = `UPDATE appointments SET doctor_name = ? WHERE doctor_name = ?`;
          db.query(updateAppointmentsQuery, [newDoctorName, currentDoctorName], (err, result) => {
            if (err) {
              console.error('Error updating appointments with new doctor name:', err);
              // Still return success since admin profile was updated
              return res.status(200).json({ 
                success: true, 
                message: 'Profile updated but patient records not updated' 
              });
            }
            res.status(200).json({ success: true, message: 'Profile updated successfully' });
          });
        } else {
          res.status(200).json({ success: true, message: 'Profile updated successfully' });
        }
      });
    } catch (error) {
      console.error('Error updating admin profile:', error);
      res.status(500).json({ success: false, message: 'Error updating admin profile' });
    }
  });
});

// Dynamic Appointments Endpoints
app.get('/admin/appointments', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const adminId = req.session.adminId;
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().split(' ')[0];

  const adminQuery = `SELECT doctor_name, avg_time_per_patient FROM admins WHERE id = ?`;
  db.query(adminQuery, [adminId], (err, adminResults) => {
    if (err || adminResults.length === 0) {
      return res.status(500).json({ success: false, message: 'Error fetching admin details' });
    }

    const admin = adminResults[0];

    const ongoingQuery = `
      SELECT id, user_id, first_name, last_name, appointment_time
      FROM appointments
      WHERE appointment_date = ? AND doctor_name = ? AND status = 'pending'
      AND appointment_time <= ? 
      AND DATE_ADD(appointment_time, INTERVAL ? MINUTE) >= ?
      ORDER BY appointment_time
    `;
    db.query(ongoingQuery, [date, admin.doctor_name, now, admin.avg_time_per_patient, now], (err, ongoingAppointments) => {
      if (err) {
        console.error('Error fetching ongoing appointments:', err);
        return res.status(500).json({ success: false, message: 'Error fetching ongoing appointments' });
      }

      const upcomingQuery = `
        SELECT id, user_id, first_name, last_name, appointment_time
        FROM appointments
        WHERE appointment_date = ? AND doctor_name = ? AND status = 'pending'
        AND appointment_time > ?
        ORDER BY appointment_time
      `;
      db.query(upcomingQuery, [date, admin.doctor_name, now], (err, upcomingAppointments) => {
        if (err) {
          console.error('Error fetching upcoming appointments:', err);
          return res.status(500).json({ success: false, message: 'Error fetching upcoming appointments' });
        }

        res.status(200).json({
          success: true,
          ongoingAppointments,
          upcomingAppointments
        });
      });
    });
  });
});

// Existing Endpoints (with minor updates for consistency)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/admin-signup', async (req, res) => {
  const { hospital_name, doctor_name, doctor_degree, email, license_number, avg_time_per_patient, location, password } = req.body;

  if (!hospital_name || !doctor_name || !doctor_degree || !email || !license_number || !avg_time_per_patient || !location || !password) {
    return res.status(400).json({ success: false, message: 'All fields are required' });
  }

  const checkEmailQuery = `SELECT * FROM admins WHERE email = ?`;
  db.query(checkEmailQuery, [email], async (err, emailResults) => {
    if (err) {
      console.error('Error checking email:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }

    if (emailResults.length > 0) {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }

    const checkLicenseQuery = `SELECT * FROM admins WHERE license_number = ?`;
    db.query(checkLicenseQuery, [license_number], async (err, licenseResults) => {
      if (err) {
        console.error('Error checking license number:', err);
        return res.status(500).json({ success: false, message: 'Server error' });
      }

      if (licenseResults.length > 0) {
        return res.status(400).json({ success: false, message: 'License number already exists' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const insertQuery = `
        INSERT INTO admins (hospital_name, doctor_name, doctor_degree, email, license_number, avg_time_per_patient, location, password)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      db.query(
        insertQuery,
        [hospital_name, doctor_name, doctor_degree, email, license_number, avg_time_per_patient, location, hashedPassword],
        (err, results) => {
          if (err) {
            console.error('Error during admin signup:', err);
            return res.status(500).json({ success: false, message: 'Error during signup' });
          }
          res.status(200).json({ success: true, message: 'Admin signup successful' });
        }
      );
    });
  });
});

// Add this endpoint to save prescriptions with multiple medicines
app.post('/admin/save-prescription/:appointmentId', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const appointmentId = req.params.appointmentId;
  const { medicines, notes } = req.body;

  if (!medicines || !Array.isArray(medicines)) {
    return res.status(400).json({ success: false, message: 'Medicines data is required' });
  }

  // Format the prescription
  const formattedMedicines = medicines.map(med => 
    `${med.name}${med.dosage ? ` (${med.dosage})` : ''}${med.duration ? ` - ${med.duration}` : ''}${med.instructions ? ` - ${med.instructions}` : ''}`
  ).join('\n');

  const prescription = `Prescription:\n${formattedMedicines}\n\nNotes: ${notes || 'None'}`;

  const updateQuery = `
    UPDATE appointments
    SET prescription = ?, status = 'completed'
    WHERE id = ?
  `;
  
  db.query(updateQuery, [prescription, appointmentId], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Error saving prescription' });
    }
    res.status(200).json({ success: true, message: 'Prescription saved successfully' });
  });
});

// Add this endpoint to get prescription data
app.get('/admin/get-prescription/:appointmentId', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const appointmentId = req.params.appointmentId;
  const query = `
    SELECT a.prescription, a.first_name, a.last_name, b.doctor_name
    FROM appointments a
    JOIN admins b ON a.doctor_name = b.doctor_name
    WHERE a.id = ?
  `;
  
  db.query(query, [appointmentId], (err, results) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Error fetching prescription' });
    }
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }
    res.status(200).json({ success: true, data: results[0] });
  });
});


// New endpoint to get appointments ordered by token number
app.get('/admin/appointments-by-token', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const adminId = req.session.adminId;
  const today = new Date().toISOString().split('T')[0];

  const adminQuery = `SELECT doctor_name FROM admins WHERE id = ?`;
  db.query(adminQuery, [adminId], (err, adminResults) => {
    if (err || adminResults.length === 0) {
      return res.status(500).json({ success: false, message: 'Error fetching admin details' });
    }

    const doctorName = adminResults[0].doctor_name;

    const query = `
      SELECT * FROM appointments 
      WHERE appointment_date = ? 
      AND doctor_name = ? 
      AND status = 'pending'
      ORDER BY token_number ASC
    `;
    
    db.query(query, [today, doctorName], (err, results) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Error fetching appointments' });
      }

      // First appointment is ongoing, others are upcoming
      const ongoing = results.length > 0 ? [results[0]] : [];
      const upcoming = results.length > 1 ? results.slice(1) : [];

      res.status(200).json({
        success: true,
        ongoingAppointments: ongoing,
        upcomingAppointments: upcoming
      });
    });
  });
});

// Endpoint to mark appointment as completed
app.post('/admin/complete-appointment/:appointmentId', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const appointmentId = req.params.appointmentId;
  const updateQuery = `
    UPDATE appointments 
    SET status = 'completed' 
    WHERE id = ?
  `;
  
  db.query(updateQuery, [appointmentId], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Error completing appointment' });
    }
    res.status(200).json({ success: true, message: 'Appointment completed' });
  });
});

app.post('/admin-login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  const query = `SELECT * FROM admins WHERE email = ?`;
  db.query(query, [email], async (err, results) => {
    if (err) {
      console.error('Error during admin login:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }

    if (results.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const admin = results[0];
    try {
      const isValidPassword = await bcrypt.compare(password, admin.password);
      if (!isValidPassword) {
        return res.status(401).json({ success: false, message: 'Invalid email or password' });
      }

      req.session.adminId = admin.id;
      req.session.adminEmail = admin.email;
      req.session.adminName = admin.doctor_name;
      
      return res.status(200).json({ 
        success: true, 
        message: 'Login successful',
        admin: {
          id: admin.id,
          name: admin.doctor_name,
          hospital: admin.hospital_name
        }
      });
    } catch (error) {
      console.error('Error comparing passwords:', error);
      return res.status(500).json({ success: false, message: 'Server error during authentication' });
    }
  });
});

app.get('/admin-dashboard', (req, res) => {
  if (!req.session.adminId) {
    return res.redirect('/admin-login');
  }

  const adminId = req.session.adminId;
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const currentDate = today.getDate();
  const todayDateString = today.toISOString().split('T')[0];

  const adminQuery = `SELECT id, doctor_name, hospital_name FROM admins WHERE id = ?`;
  db.query(adminQuery, [adminId], (err, adminResults) => {
    if (err || adminResults.length === 0) {
      return res.status(500).render('admin-dashboard', {
        admin: { name: 'Unknown', hospital_name: 'Unknown' },
        totalVisits: 0,
        newPatients: 0,
        oldPatients: 0,
        ongoingAppointments: [],
        upcomingAppointments: [],
        calendar: { year: currentYear, month: currentMonth, days: [], today: currentDate },
        error: 'Error fetching admin details'
      });
    }

    const admin = adminResults[0];
    const now = new Date().toTimeString().split(' ')[0];

    const totalVisitsQuery = `
      SELECT COUNT(*) as total 
      FROM appointments 
      WHERE appointment_date = ? AND doctor_name = ? AND status = 'pending'
    `;
    db.query(totalVisitsQuery, [todayDateString, admin.doctor_name], (err, totalVisitsResult) => {
      const totalVisits = err ? 0 : totalVisitsResult[0].total;

      const newPatientsQuery = `
        SELECT COUNT(DISTINCT user_id) as new_patients
        FROM appointments
        WHERE appointment_date = ? AND doctor_name = ? AND status = 'pending'
        AND user_id IN (
          SELECT user_id 
          FROM appointments 
          GROUP BY user_id 
          HAVING COUNT(*) = 1
        )
      `;
      db.query(newPatientsQuery, [todayDateString, admin.doctor_name], (err, newPatientsResult) => {
        const newPatients = err ? 0 : newPatientsResult[0].new_patients;
        const oldPatients = totalVisits - newPatients;

        const ongoingAppointmentsQuery = `
          SELECT id, first_name, last_name, appointment_time
          FROM appointments
          WHERE appointment_date = ? AND doctor_name = ? AND status = 'pending'
          AND appointment_time <= ? 
          AND DATE_ADD(appointment_time, INTERVAL (SELECT avg_time_per_patient FROM admins WHERE id = ?) MINUTE) >= ?
          ORDER BY appointment_time
        `;
        db.query(ongoingAppointmentsQuery, [todayDateString, admin.doctor_name, now, adminId, now], (err, ongoingAppointments) => {
          const upcomingAppointmentsQuery = `
            SELECT id, first_name, last_name, appointment_time
            FROM appointments
            WHERE appointment_date = ? AND doctor_name = ? AND status = 'pending'
            AND appointment_time > ?
            ORDER BY appointment_time
          `;
          db.query(upcomingAppointmentsQuery, [todayDateString, admin.doctor_name, now], (err, upcomingAppointments) => {
            const firstDayOfMonth = new Date(currentYear, currentMonth - 1, 1).getDay();
            const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
            const calendarDays = Array(firstDayOfMonth).fill(null).concat(
              Array.from({ length: daysInMonth }, (_, i) => i + 1)
            );

            const appointmentsInMonthQuery = `
              SELECT DAY(appointment_date) as day, COUNT(*) as count
              FROM appointments
              WHERE YEAR(appointment_date) = ? AND MONTH(appointment_date) = ?
              AND doctor_name = ? AND status = 'pending'
              GROUP BY DAY(appointment_date)
            `;
            db.query(appointmentsInMonthQuery, [currentYear, currentMonth, admin.doctor_name], (err, appointmentDays) => {
              const appointmentsMap = {};
              if (!err && appointmentDays) {
                appointmentDays.forEach(row => {
                  appointmentsMap[row.day] = row.count;
                });
              }

              res.render('admin-dashboard', {
                admin,
                totalVisits,
                newPatients,
                oldPatients,
                ongoingAppointments: err ? [] : ongoingAppointments,
                upcomingAppointments: err ? [] : upcomingAppointments,
                calendar: {
                  year: currentYear,
                  month: currentMonth,
                  days: calendarDays,
                  today: currentDate,
                  appointments: appointmentsMap
                },
                error: null
              });
            });
          });
        });
      });
    });
  });
});

// Enhanced Visit Tracking Endpoint - Complete Implementation
app.get('/admin/visits', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const adminId = req.session.adminId;
  const date = req.query.date || new Date().toISOString().split('T')[0];

  // First get the doctor's name
  const adminQuery = `SELECT doctor_name FROM admins WHERE id = ?`;
  db.query(adminQuery, [adminId], (err, adminResults) => {
    if (err || adminResults.length === 0) {
      return res.status(500).json({ success: false, message: 'Error fetching admin details' });
    }

    const doctorName = adminResults[0].doctor_name;

    // Query to get total visits (both pending and completed)
    const totalVisitsQuery = `
      SELECT COUNT(*) as total 
      FROM appointments 
      WHERE appointment_date = ? AND doctor_name = ?
    `;
    
    // Query to get completed visits
    const completedVisitsQuery = `
      SELECT COUNT(*) as completed
      FROM appointments
      WHERE appointment_date = ? AND doctor_name = ? AND status = 'completed'
    `;
    
    // Query to get new patients (first-time visitors)
    const newPatientsQuery = `
      SELECT COUNT(DISTINCT user_id) as new_patients
      FROM appointments
      WHERE appointment_date = ? AND doctor_name = ?
      AND user_id IN (
        SELECT user_id 
        FROM appointments 
        GROUP BY user_id 
        HAVING COUNT(*) = 1
      )
    `;

    // Execute all queries in parallel for better performance
    Promise.all([
      new Promise((resolve) => 
        db.query(totalVisitsQuery, [date, doctorName], (err, results) => 
          resolve(err ? 0 : results[0].total)
        )
      ),
      new Promise((resolve) => 
        db.query(completedVisitsQuery, [date, doctorName], (err, results) => 
          resolve(err ? 0 : results[0].completed)
        )
      ),
      new Promise((resolve) => 
        db.query(newPatientsQuery, [date, doctorName], (err, results) => 
          resolve(err ? 0 : results[0].new_patients)
        )
      )
    ]).then(([totalVisits, completedVisits, newPatients]) => {
      // Calculate old patients (returning patients)
      const oldPatients = totalVisits - newPatients;
      
      // Get detailed list of completed visits
      const completedDetailsQuery = `
        SELECT id, first_name, last_name, appointment_time
        FROM appointments
        WHERE appointment_date = ? AND doctor_name = ? AND status = 'completed'
        ORDER BY appointment_time DESC
        LIMIT 10
      `;
      
      db.query(completedDetailsQuery, [date, doctorName], (err, completedDetails) => {
        res.status(200).json({
          success: true,
          stats: {
            totalVisits,
            completedVisits,
            pendingVisits: totalVisits - completedVisits,
            newPatients,
            oldPatients,
            completionRate: totalVisits > 0 ? Math.round((completedVisits / totalVisits) * 100) : 0
          },
          recentCompleted: err ? [] : completedDetails
        });
      });
    }).catch(error => {
      console.error('Error fetching visit stats:', error);
      res.status(500).json({ success: false, message: 'Error fetching visit statistics' });
    });
  });
});

app.get('/admin/patient-details/:appointmentId', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const appointmentId = req.params.appointmentId;
  const query = `
    SELECT id, user_id, first_name, last_name, gender, phone_number, age, location, appointment_date, appointment_time, doctor_name, status, token_number
    FROM appointments
    WHERE id = ?
  `;
  db.query(query, [appointmentId], (err, results) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Error fetching patient details' });
    }

    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    const patient = results[0];

    if (!patient.token_number) {
      const tokenQuery = `
        SELECT COUNT(*) as count
        FROM appointments
        WHERE appointment_date = ? AND doctor_name = ? AND status = 'pending'
        AND id <= ?
      `;
      db.query(tokenQuery, [patient.appointment_date, patient.doctor_name, patient.id], (err, tokenResult) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'Error generating token number' });
        }

        const tokenNumber = tokenResult[0].count;
        const updateQuery = `UPDATE appointments SET token_number = ? WHERE id = ?`;
        db.query(updateQuery, [tokenNumber, patient.id], (err) => {
          if (err) {
            return res.status(500).json({ success: false, message: 'Error updating token number' });
          }

          patient.token_number = tokenNumber;
          res.status(200).json({ success: true, patient });
        });
      });
    } else {
      res.status(200).json({ success: true, patient });
    }
  });
});

// Enhanced Prescription Saving Endpoint
app.post('/admin/save-prescription/:appointmentId', async (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const appointmentId = req.params.appointmentId;
  const { medicines, notes } = req.body;

  if (!medicines || !Array.isArray(medicines)) {
    return res.status(400).json({ success: false, message: 'Medicines data is required' });
  }

  try {
    // Get patient and doctor information
    const [appointmentData, adminData] = await Promise.all([
      new Promise((resolve, reject) => {
        db.query(
          'SELECT first_name, last_name, age, gender FROM appointments WHERE id = ?',
          [appointmentId],
          (err, results) => err ? reject(err) : resolve(results[0])
        );
      }),
      new Promise((resolve, reject) => {
        db.query(
          'SELECT doctor_name, hospital_name, location, license_number FROM admins WHERE id = ?',
          [req.session.adminId],
          (err, results) => err ? reject(err) : resolve(results[0])
        );
      })
    ]);

    // Format the beautiful prescription
    const prescription = formatPrescription(
      medicines,
      notes,
      {
        firstName: appointmentData.first_name,
        lastName: appointmentData.last_name,
        age: appointmentData.age,
        gender: appointmentData.gender
      },
      {
        doctorName: adminData.doctor_name,
        hospitalName: adminData.hospital_name,
        location: adminData.location,
        licenseNumber: adminData.license_number
      }
    );

    // Save to database
    const updateQuery = `
      UPDATE appointments
      SET prescription = ?, status = 'completed'
      WHERE id = ?
    `;
    
    db.query(updateQuery, [prescription, appointmentId], (err) => {
      if (err) {
        console.error('Error saving prescription:', err);
        return res.status(500).json({ success: false, message: 'Error saving prescription' });
      }
      res.status(200).json({ 
        success: true, 
        message: 'Prescription saved successfully',
        prescription: prescription // Return formatted prescription
      });
    });

  } catch (error) {
    console.error('Error in prescription creation:', error);
    res.status(500).json({ success: false, message: 'Error creating prescription' });
  }
});

app.get('/admin/previous-patients', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const adminId = req.session.adminId;
  const adminQuery = `SELECT doctor_name FROM admins WHERE id = ?`;
  db.query(adminQuery, [adminId], (err, adminResults) => {
    if (err || adminResults.length === 0) {
      return res.status(500).json({ success: false, message: 'Error fetching admin details' });
    }

    const admin = adminResults[0];
    const query = `
      SELECT id, user_id, first_name, last_name, gender, phone_number, age, location, appointment_date, appointment_time, doctor_name, status, token_number, prescription
      FROM appointments
      WHERE doctor_name = ? AND status = 'completed'
      ORDER BY appointment_date DESC, appointment_time DESC
    `;
    db.query(query, [admin.doctor_name], (err, results) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Error fetching previous patients' });
      }

      res.status(200).json({ success: true, patients: results });
    });
  });
});

// Enhanced Prescription Viewing Endpoint
app.get('/admin/prescription/:appointmentId', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const appointmentId = req.params.appointmentId;
  
  const query = `
    SELECT a.prescription, a.first_name, a.last_name, a.age, a.gender,
           b.doctor_name, b.hospital_name, b.license_number, b.location
    FROM appointments a
    JOIN admins b ON a.doctor_name = b.doctor_name
    WHERE a.id = ?
  `;
  
  db.query(query, [appointmentId], (err, results) => {
    if (err) {
      console.error('Error fetching prescription:', err);
      return res.status(500).json({ success: false, message: 'Error fetching prescription' });
    }
    
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    const data = results[0];
    
    // Return both raw and formatted prescription
    res.status(200).json({ 
      success: true,
      prescription: data.prescription,
      patientInfo: {
        name: `${data.first_name} ${data.last_name}`,
        age: data.age,
        gender: data.gender
      },
      doctorInfo: {
        name: data.doctor_name,
        hospital: data.hospital_name,
        license: data.license_number
      }
    });
  });
});

// PDF Generation Endpoint
app.get('/admin/prescription-pdf/:appointmentId', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const appointmentId = req.params.appointmentId;
  
  const query = `
    SELECT a.prescription, a.first_name, a.last_name, a.age, a.gender,
           b.doctor_name, b.hospital_name, b.license_number
    FROM appointments a
    JOIN admins b ON a.doctor_name = b.doctor_name
    WHERE a.id = ?
  `;
  
  db.query(query, [appointmentId], (err, results) => {
    if (err || results.length === 0) {
      return res.status(500).send('Error generating PDF');
    }

    const data = results[0];
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=prescription_${appointmentId}.pdf`);
    
    // Pipe PDF to response
    doc.pipe(res);

    // Add header
    doc.fontSize(20).fillColor('#2c3e50').text(data.hospital_name, 50, 50, { align: 'center' });
    doc.fontSize(12).fillColor('#7f8c8d').text(data.location, 50, 80, { align: 'center' });
    
    // Add patient info
    doc.moveDown();
    doc.fontSize(14).fillColor('#2c3e50').text('Patient Information:', 50, 120);
    doc.fontSize(12).text(`Name: ${data.first_name} ${data.last_name}`, 50, 150);
    if (data.age) doc.text(`Age: ${data.age}`, 50, 170);
    if (data.gender) doc.text(`Gender: ${data.gender}`, 50, 190);
    
    // Add prescription info
    doc.fontSize(14).fillColor('#2c3e50').text('Prescription Details:', 50, 230);
    doc.fontSize(12).text(`Date: ${new Date().toLocaleDateString()}`, 300, 150);
    doc.text(`Doctor: Dr. ${data.doctor_name}`, 300, 170);
    if (data.license_number) doc.text(`License: ${data.license_number}`, 300, 190);
    
    // Add prescription content
    doc.moveDown();
    doc.fontSize(14).fillColor('#2c3e50').text('Medications:', 50, 270);
    
    // Parse HTML and add to PDF (simplified example)
    const prescriptionText = data.prescription.replace(/<[^>]*>/g, '\n');
    doc.fontSize(12).fillColor('#000000').text(prescriptionText, 50, 300, {
      width: 500,
      align: 'left'
    });
    
    // Add footer
    doc.fontSize(10).fillColor('#7f8c8d')
       .text('This is a computer-generated prescription. No signature required.', 50, 700, { align: 'center' });
    doc.text(`${data.hospital_name} © ${new Date().getFullYear()}`, 50, 720, { align: 'center' });
    
    // Finalize PDF
    doc.end();
  });
});

// New endpoint for medicine suggestions
app.get('/api/medicine-suggestions', async (req, res) => {
  try {
    const { query } = req.query;
    
    // 1. First check local database
    const localResults = await new Promise((resolve) => {
      db.query('SELECT * FROM medicines WHERE name LIKE ? LIMIT 10', [`%${query}%`], (err, results) => {
        resolve(err ? [] : results);
      });
    });

    if (localResults.length > 0) {
      return res.json(localResults);
    }

    // 2. Fallback to FDA API
    const apiResponse = await axios.get(
      `https://api.fda.gov/drug/label.json?search=openfda.brand_name:${query}*&limit=10`
    );

    const medicines = apiResponse.data.results.map(item => ({
      name: item.openfda?.brand_name?.[0] || 'Unknown',
      dosage: item.dosage_and_administration?.[0]?.substring(0, 100) || '',
      description: item.description?.[0]?.substring(0, 200) || ''
    }));

    // 3. Cache results locally
    await Promise.all(
      medicines.map(med => 
        new Promise((resolve) => {
          db.query(
            'INSERT INTO medicines (name, dosage, description) VALUES (?, ?, ?)',
            [med.name, med.dosage, med.description],
            resolve
          );
        })
      )
    );

    res.json(medicines);
  } catch (error) {
    console.error('Medicine search error:', error);
    res.status(500).json({ error: 'Failed to search medicines' });
  }
});

app.post('/admin-logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  });
});

// User-related endpoints (keep existing)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const query = `SELECT * FROM users WHERE email = ?`;
  db.query(query, [username], async (err, results) => {
    if (err) {
      res.status(500).send('Server error');
      return;
    }
    if (results.length > 0) {
      const isValidPassword = await bcrypt.compare(password, results[0].password);
      if (isValidPassword) {
        req.session.userId = results[0].id;
        res.status(200).json({ success: true, message: 'Login successful' });
      } else {
        res.status(401).json({ success: false, message: 'Invalid username or password' });
      }
    } else {
      res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
  });
});

app.get('/home3.html', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  res.render('home3', { id: req.session.userId });
});

app.get('/profile', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  const userId = req.session.userId;
  const query = `SELECT id, first_name, last_name, email, gender, phone_number, dob, location, photo FROM users WHERE id = ?`;
  db.query(query, [userId], (err, results) => {
    if (err) {
      res.status(500).send('Server error');
      return;
    }
    if (results.length > 0) {
      res.render('profile', { user: results[0], id: req.session.userId });
    } else {
      res.status(404).send('User not found');
    }
  });
});

app.post('/update-profile', (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).send('Unauthorized');
  }
  const { gender, phone_number, dob, location, photo } = req.body;
  if (!gender || !phone_number || !dob || !location) {
    return res.status(400).send('All fields are required');
  }
  const query = `
    UPDATE users
    SET gender = ?, phone_number = ?, dob = ?, location = ?, photo = ?
    WHERE id = ?
  `;
  db.query(
    query,
    [gender, phone_number, dob, location, photo || null, userId],
    (err, results) => {
      if (err) {
        return res.status(500).send('Error updating profile');
      }
      res.redirect(`/profile?userId=${userId}`);
    }
  );
});

app.get('/create-appointment', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  const doctorsQuery = `SELECT doctor_name FROM admins`;
  db.query(doctorsQuery, (err, doctors) => {
    if (err) {
      return res.status(500).render('create-appointment', { doctors: [], error: 'Error fetching doctors' });
    }
    res.render('create-appointment', { doctors, error: null });
  });
});

app.post('/submit-appointment', (req, res) => {
  const { first_name, last_name, gender, phone_number, age, location, appointment_date, appointment_time, doctor_name } = req.body;
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'You must be logged in to create an appointment' });
  }
  if (!first_name || !last_name || !appointment_date || !appointment_time || !doctor_name) {
    return res.status(400).json({ success: false, message: 'First name, last name, appointment date, time, and doctor name are required' });
  }
  const query = `
    INSERT INTO appointments (user_id, first_name, last_name, gender, phone_number, age, location, appointment_date, appointment_time, doctor_name, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `;
  db.query(
    query,
    [userId, first_name, last_name, gender, phone_number, age, location, appointment_date, appointment_time, doctor_name],
    (err, results) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Error creating appointment' });
      }
      res.status(200).json({ success: true, message: 'Appointment created successfully' });
    }
  );
});

app.get('/appointments', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  const userId = req.session.userId;
  const query = `
    SELECT id, first_name, last_name, gender, phone_number, age, location, appointment_date, appointment_time, doctor_name, status, prescription
    FROM appointments
    WHERE user_id = ?
  `;
  db.query(query, [userId], (err, results) => {
    if (err) {
      res.status(500).send('Server error');
      return;
    }
    res.render('appointments', { appointments: results });
  });
});

app.get('/prescription/:appointmentId', (req, res) => {
  const appointmentId = req.params.appointmentId;
  const query = `
    SELECT id, first_name, last_name, gender, age, appointment_date, appointment_time, doctor_name, prescription
    FROM appointments
    WHERE id = ?
  `;
  db.query(query, [appointmentId], (err, results) => {
    if (err) {
      res.status(500).send('Error fetching prescription details');
      return;
    }
    if (results.length > 0) {
      res.render('prescription', { prescription: results[0] });
    } else {
      res.status(404).send('Appointment not found');
    }
  });
});

app.get('/download-prescription/:appointmentId', (req, res) => {
  const appointmentId = req.params.appointmentId;
  const query = `
    SELECT id, first_name, last_name, gender, age, appointment_date, appointment_time, doctor_name, prescription
    FROM appointments
    WHERE id = ?
  `;
  db.query(query, [appointmentId], (err, results) => {
    if (err) {
      res.status(500).send('Error fetching prescription details');
      return;
    }
    if (results.length === 0) {
      res.status(404).send('Appointment not found');
      return;
    }
    const prescription = results[0];
    const doc = new PDFDocument({ size: 'A5', margin: 50 });
    const fileName = `prescription_${appointmentId}.pdf`;
    res.setHeader('Content-disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);
    doc.fontSize(20).fillColor('#1a3c34').text('BookMyCare', 50, 30);
    doc.fontSize(16).fillColor('#1a3c34').text('Prescription', 50, 55);
    doc.fontSize(14).fillColor('#333').text(`Dr. ${prescription.doctor_name}`, 0, 90, { align: 'center' });
    doc.fontSize(12).fillColor('#666').text('BDS', 0, 105, { align: 'center' });
    doc.fontSize(12).fillColor('#333');
    doc.text(`Patient Name: ${prescription.first_name} ${prescription.last_name}`, 50, 130);
    doc.text(`Age: ${prescription.age || 'N/A'}`, 50, 145);
    doc.text(`Gender: ${prescription.gender || 'N/A'}`, 200, 145);
    doc.text(`Date: ${prescription.appointment_date.toISOString().split('T')[0]}`, 400, 130);
    doc.moveTo(50, 160).lineTo(450, 160).stroke();
    doc.fontSize(12).fillColor('#333').text('Prescription:', 50, 180);
    doc.moveTo(50, 190).lineTo(450, 190).dash(5, { space: 5 }).stroke();
    const prescriptionText = prescription.prescription || 'No prescription provided';
    const lines = prescriptionText.split('\n');
    let yPos = 210;
    lines.forEach((line, index) => {
      doc.text(`${index + 1}. ${line}`, 70, yPos);
      yPos += 20;
      doc.moveTo(50, yPos).lineTo(450, yPos).dash(5, { space: 5 }).stroke();
    });
    yPos += 20;
    doc.fontSize(12).fillColor('#333').text('Signature', 400, yPos, { align: 'right' });
    doc.moveTo(350, yPos + 10).lineTo(450, yPos + 10).stroke();
    doc.fontSize(10).fillColor('#666');
    doc.text('CLINIC NAME', 50, yPos + 40);
    doc.text('Pradhikaran', 50, yPos + 55);
    doc.text('9175925216', 450, yPos + 55, { align: 'right' });
    doc.moveTo(50, yPos + 30).lineTo(450, yPos + 30).stroke();
    doc.end();
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});