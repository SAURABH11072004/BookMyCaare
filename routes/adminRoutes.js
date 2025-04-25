const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/db');
const PDFDocument = require('pdfkit');
const { formatPrescription } = require('../utils/prescription');
const cors = require('cors');

// Middleware to check if the user is an authenticated admin
const isAdminAuthenticated = (req, res, next) => {
    console.log('Session check:', req.session);
    if (req.session && req.session.adminId) {
        return next();
    } else {
        console.log('Unauthorized access attempt');
        res.status(401).json({ success: false, message: 'Unauthorized: Please log in as an admin' });
    }
};

// Helper function to get the current date or a specified date
const getDate = (dateStr = null) => {
    return dateStr ? new Date(dateStr).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
};

// Enable CORS (if frontend and backend are on different ports)
router.use(cors());

router.get('/profile', isAdminAuthenticated, (req, res) => {
    const adminId = req.session.adminId;
    db.query('SELECT * FROM admins WHERE id = ?', [adminId], (err, results) => {
        if (err) {
            console.error('Error fetching admin profile:', err);
            return res.status(500).json({ success: false, message: 'Error fetching admin profile', error: err.message });
        }
        if (results.length === 0) return res.status(404).json({ success: false, message: 'Admin not found' });
        const admin = results[0];
        delete admin.password;
        res.status(200).json({ success: true, admin });
    });
});

router.post('/update-profile', isAdminAuthenticated, async (req, res) => {
    const adminId = req.session.adminId;
    const { hospital_name, doctor_name, doctor_degree, email, license_number, avg_time_per_patient, location, password } = req.body;

    db.query('SELECT * FROM admins WHERE id = ?', [adminId], async (err, adminResults) => {
        if (err || adminResults.length === 0) {
            console.error('Error fetching admin details:', err);
            return res.status(500).json({ success: false, message: 'Error fetching admin details', error: err?.message });
        }
        const currentAdmin = adminResults[0];
        const currentDoctorName = currentAdmin.doctor_name;
        const newDoctorName = doctor_name;

        try {
            let updateFields = { hospital_name, doctor_name, doctor_degree, email, license_number, avg_time_per_patient, location };
            if (password) updateFields.password = await bcrypt.hash(password, 10);

            db.query('UPDATE admins SET ? WHERE id = ?', [updateFields, adminId], (err) => {
                if (err) {
                    console.error('Error updating admin profile:', err);
                    return res.status(500).json({ success: false, message: 'Error updating admin profile', error: err.message });
                }
                if (currentDoctorName !== newDoctorName) {
                    db.query('UPDATE appointments SET doctor_name = ? WHERE doctor_name = ?', [newDoctorName, currentDoctorName], (err) => {
                        if (err) {
                            console.error('Error updating appointments with new doctor name:', err);
                            return res.status(200).json({ success: true, message: 'Profile updated but patient records not updated' });
                        }
                        res.status(200).json({ success: true, message: 'Profile updated successfully' });
                    });
                } else {
                    res.status(200).json({ success: true, message: 'Profile updated successfully' });
                }
            });
        } catch (error) {
            console.error('Error hashing password:', error);
            res.status(500).json({ success: false, message: 'Error updating admin profile', error: error.message });
        }
    });
});

router.get('/appointments', isAdminAuthenticated, (req, res) => {
    const adminId = req.session.adminId;
    const date = getDate();
    const now = new Date().toTimeString().split(' ')[0];

    db.query('SELECT doctor_name, avg_time_per_patient FROM admins WHERE id = ?', [adminId], (err, adminResults) => {
        if (err || adminResults.length === 0) {
            console.error('Error fetching admin details:', err);
            return res.status(500).json({ success: false, message: 'Error fetching admin details', error: err?.message });
        }
        const admin = adminResults[0];

        const ongoingQuery = `
            SELECT id, user_id, first_name, last_name, appointment_time
            FROM appointments
            WHERE appointment_date = ? AND admin_id = ? AND status IN ('pending', 'ongoing')
            AND appointment_time <= ? 
            AND DATE_ADD(appointment_time, INTERVAL ? MINUTE) >= ?
            ORDER BY appointment_time
            LIMIT 1
        `;
        db.query(ongoingQuery, [date, adminId, now, admin.avg_time_per_patient, now], (err, ongoingAppointments) => {
            if (err) {
                console.error('Error fetching ongoing appointments:', err);
                return res.status(500).json({ success: false, message: 'Error fetching ongoing appointments', error: err.message });
            }

            const upcomingQuery = `
                SELECT id, user_id, first_name, last_name, appointment_time
                FROM appointments
                WHERE appointment_date = ? AND admin_id = ? AND status = 'pending'
                AND appointment_time > ?
                ORDER BY appointment_time
            `;
            db.query(upcomingQuery, [date, adminId, now], (err, upcomingAppointments) => {
                if (err) {
                    console.error('Error fetching upcoming appointments:', err);
                    return res.status(500).json({ success: false, message: 'Error fetching upcoming appointments', error: err.message });
                }
                res.status(200).json({ success: true, ongoingAppointments, upcomingAppointments });
            });
        });
    });
});

router.get('/appointments-by-token', isAdminAuthenticated, (req, res) => {
    const adminId = req.session.adminId;
    console.log('Fetching appointments for adminId:', adminId);
    const date = getDate(req.query.date || null);
    console.log('Requested date:', date);

    if (!adminId) {
        console.error('No adminId in session');
        return res.status(401).json({ success: false, message: 'No admin session found' });
    }

    db.query(
        `SELECT a.* FROM appointments a 
         JOIN admins ad ON a.admin_id = ad.id 
         WHERE a.appointment_date = ? 
         AND ad.id = ? 
         AND a.status IN ('pending', 'ongoing', 'completed') 
         ORDER BY a.appointment_time ASC, a.id ASC`,
        [date, adminId],
        (err, results) => {
            if (err) {
                console.error('Database error fetching appointments:', err);
                return res.status(500).json({ success: false, message: 'Database error fetching appointments', error: err.message });
            }
            console.log('Fetched appointments count:', results.length);

            // Synchronously assign token numbers to avoid race conditions
            let tokenCount = 1;
            const updatedResults = results.map(appointment => {
                if (!appointment.token_number || appointment.token_number === 0) {
                    appointment.token_number = tokenCount++;
                    db.query('UPDATE appointments SET token_number = ? WHERE id = ?', [appointment.token_number, appointment.id], (updateErr) => {
                        if (updateErr) console.error('Error updating token number for ID', appointment.id, ':', updateErr.message);
                    });
                } else if (appointment.token_number >= tokenCount) {
                    tokenCount = appointment.token_number + 1;
                }
                return appointment;
            });

            const ongoingAppointments = updatedResults.filter(a => a.status === 'ongoing');
            const upcomingAppointments = updatedResults.filter(a => a.status === 'pending');

            console.log('Ongoing appointments:', ongoingAppointments.length);
            console.log('Upcoming appointments:', upcomingAppointments.length);
            res.status(200).json({ success: true, ongoingAppointments, upcomingAppointments });
        }
    );
});

router.post('/save-prescription/:appointmentId', isAdminAuthenticated, async (req, res) => {
    const appointmentId = req.params.appointmentId;
    const { medicines, notes } = req.body;

    if (!medicines || !Array.isArray(medicines)) {
        return res.status(400).json({ success: false, message: 'Medicines data is required' });
    }

    try {
        const [appointmentData] = await new Promise((resolve, reject) => {
            db.query('SELECT first_name, last_name, age, gender, admin_id, appointment_date, appointment_time FROM appointments WHERE id = ?', [appointmentId], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });
        if (!appointmentData) return res.status(404).json({ success: false, message: 'Appointment not found' });

        const [adminData] = await new Promise((resolve, reject) => {
            db.query('SELECT doctor_name, hospital_name, location, license_number FROM admins WHERE id = ?', [req.session.adminId || appointmentData.admin_id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });
        if (!adminData) return res.status(404).json({ success: false, message: 'Admin not found' });

        const prescriptionText = formatPrescription(medicines, notes, {
            firstName: appointmentData.first_name,
            lastName: appointmentData.last_name,
            age: appointmentData.age,
            gender: appointmentData.gender
        }, {
            doctorName: adminData.doctor_name,
            hospitalName: adminData.hospital_name,
            location: adminData.location,
            licenseNumber: adminData.license_number
        });
        console.log('Saving prescription for appointmentId:', appointmentId, 'Prescription:', prescriptionText);

        // Update appointment to completed and handle next patient
        db.query('UPDATE appointments SET prescription = ?, status = "completed" WHERE id = ?', [prescriptionText, appointmentId], (err) => {
            if (err) {
                console.error('Error updating prescription:', err);
                return res.status(500).json({ success: false, message: 'Error saving prescription', error: err.message });
            }

            // Find and update the next pending appointment to "ongoing"
            db.query(
                `SELECT id
                 FROM appointments
                 WHERE appointment_date = ? 
                 AND admin_id = ? 
                 AND status = 'pending'
                 AND appointment_time > ?
                 ORDER BY appointment_time ASC
                 LIMIT 1`,
                [appointmentData.appointment_date, appointmentData.admin_id, appointmentData.appointment_time],
                (err, nextAppointments) => {
                    if (err) {
                        console.error('Error finding next appointment:', err);
                        return res.status(500).json({ success: false, message: 'Error finding next appointment', error: err.message });
                    }
                    if (nextAppointments.length > 0) {
                        const nextAppointmentId = nextAppointments[0].id;
                        db.query('UPDATE appointments SET status = "ongoing" WHERE id = ?', [nextAppointmentId], (err) => {
                            if (err) console.error('Error updating next appointment:', err);
                        });
                    }

                    // Fetch updated appointments with unique token numbers
                    db.query(
                        `SELECT a.* FROM appointments a 
                         JOIN admins ad ON a.admin_id = ad.id 
                         WHERE a.appointment_date = ? 
                         AND ad.id = ? 
                         AND a.status IN ('pending', 'ongoing', 'completed') 
                         ORDER BY a.appointment_time ASC, a.id ASC`,
                        [appointmentData.appointment_date, appointmentData.admin_id],
                        (err, results) => {
                            if (err) {
                                console.error('Error fetching updated appointments:', err);
                                return res.status(500).json({ success: false, message: 'Error fetching updated appointments', error: err.message });
                            }

                            let tokenCount = 1;
                            results.forEach(appointment => {
                                if (!appointment.token_number || appointment.token_number === 0) {
                                    appointment.token_number = tokenCount++;
                                    db.query('UPDATE appointments SET token_number = ? WHERE id = ?', [appointment.token_number, appointment.id], (updateErr) => {
                                        if (updateErr) console.error('Error updating token number for ID', appointment.id, ':', updateErr.message);
                                    });
                                } else if (appointment.token_number >= tokenCount) {
                                    tokenCount = appointment.token_number + 1;
                                }
                            });

                            const ongoingAppointments = results.filter(a => a.status === 'ongoing');
                            const upcomingAppointments = results.filter(a => a.status === 'pending');

                            res.status(200).json({
                                success: true,
                                message: 'Prescription saved and appointment completed',
                                ongoingAppointments,
                                upcomingAppointments
                            });
                        }
                    );
                }
            );
        });
    } catch (error) {
        console.error('Error creating prescription:', error);
        res.status(500).json({ success: false, message: 'Error creating prescription', error: error.message });
    }
});

router.post('/signup', async (req, res) => {
    const { hospital_name, doctor_name, doctor_degree, email, license_number, avg_time_per_patient, location, password } = req.body;
    if (!hospital_name || !doctor_name || !doctor_degree || !email || !license_number || !avg_time_per_patient || !location || !password) {
        return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    db.query('SELECT * FROM admins WHERE email = ?', [email], async (err, emailResults) => {
        if (err) {
            console.error('Error checking email:', err);
            return res.status(500).json({ success: false, message: 'Server error', error: err.message });
        }
        if (emailResults.length > 0) return res.status(400).json({ success: false, message: 'Email already exists' });

        db.query('SELECT * FROM admins WHERE license_number = ?', [license_number], async (err, licenseResults) => {
            if (err) {
                console.error('Error checking license:', err);
                return res.status(500).json({ success: false, message: 'Server error', error: err.message });
            }
            if (licenseResults.length > 0) return res.status(400).json({ success: false, message: 'License number already exists' });

            const hashedPassword = await bcrypt.hash(password, 10);
            db.query(
                'INSERT INTO admins (hospital_name, doctor_name, doctor_degree, email, license_number, avg_time_per_patient, location, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [hospital_name, doctor_name, doctor_degree, email, license_number, avg_time_per_patient, location, hashedPassword],
                (err) => {
                    if (err) {
                        console.error('Error during signup:', err);
                        return res.status(500).json({ success: false, message: 'Error during signup', error: err.message });
                    }
                    res.status(200).json({ success: true, message: 'Admin signup successful' });
                }
            );
        });
    });
});

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    console.log('Login attempt:', { email });
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    db.query('SELECT * FROM admins WHERE email = ?', [email], async (err, results) => {
        if (err) {
            console.error('Error during admin login:', err);
            return res.status(500).json({ success: false, message: 'Server error', error: err.message });
        }
        if (results.length === 0) {
            console.log('Email not found:', email);
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        const admin = results[0];
        try {
            const isValidPassword = await bcrypt.compare(password, admin.password);
            if (!isValidPassword) {
                console.log('Invalid password for email:', email);
                return res.status(401).json({ success: false, message: 'Invalid email or password' });
            }

            req.session.adminId = admin.id;
            req.session.adminEmail = admin.email;
            req.session.adminName = admin.doctor_name;
            console.log('Login successful:', { email, adminId: admin.id });
            return res.status(200).json({ success: true, message: 'Login successful', admin: { id: admin.id, name: admin.doctor_name, hospital: admin.hospital_name } });
        } catch (error) {
            console.error('Error comparing passwords:', error);
            return res.status(500).json({ success: false, message: 'Server error during authentication', error: error.message });
        }
    });
});

router.get('/dashboard', isAdminAuthenticated, (req, res) => {
    const adminId = req.session.adminId;
    const date = getDate(req.query.date || '2025-04-14');
    const now = new Date().toTimeString().split(' ')[0];

    db.query('SELECT id, doctor_name, hospital_name FROM admins WHERE id = ?', [adminId], (err, adminResults) => {
        if (err || adminResults.length === 0) {
            console.error('Error fetching admin details:', err);
            return res.status(500).render('admin-dashboard', { 
                admin: { name: 'Unknown', hospital_name: 'Unknown' }, 
                totalVisits: 0, 
                newPatients: 0, 
                oldPatients: 0, 
                ongoingAppointments: [], 
                upcomingAppointments: [], 
                patients: [], 
                calendar: { year: new Date(date).getFullYear(), month: new Date(date).getMonth() + 1, days: [], today: new Date(date).getDate() }, 
                error: 'Error fetching admin details', 
                selectedDate: date 
            });
        }
        const admin = adminResults[0];

        db.query('SELECT COUNT(*) as total FROM appointments WHERE appointment_date = ? AND admin_id = ? AND status IN ("pending", "ongoing", "completed")', [date, adminId], (err, totalVisitsResult) => {
            const totalVisits = err ? 0 : totalVisitsResult[0].total;

            db.query('SELECT COUNT(DISTINCT user_id) as new_patients FROM appointments WHERE appointment_date = ? AND admin_id = ? AND user_id IN (SELECT user_id FROM appointments GROUP BY user_id HAVING COUNT(*) = 1)', [date, adminId], (err, newPatientsResult) => {
                const newPatients = err ? 0 : newPatientsResult[0].new_patients;
                const oldPatients = totalVisits - newPatients;

                db.query('SELECT id, first_name, last_name, appointment_time, token_number FROM appointments WHERE appointment_date = ? AND admin_id = ? AND status IN ("pending", "ongoing") AND appointment_time <= ? AND DATE_ADD(appointment_time, INTERVAL (SELECT avg_time_per_patient FROM admins WHERE id = ?) MINUTE) >= ? ORDER BY appointment_time', [date, adminId, now, adminId, now], (err, ongoingAppointments) => {
                    db.query('SELECT id, first_name, last_name, appointment_time, token_number FROM appointments WHERE appointment_date = ? AND admin_id = ? AND status = "pending" AND appointment_time > ? ORDER BY appointment_time', [date, adminId, now], (err, upcomingAppointments) => {
                        const firstDayOfMonth = new Date(date).getDay();
                        const daysInMonth = new Date(new Date(date).getFullYear(), new Date(date).getMonth() + 1, 0).getDate();
                        const calendarDays = Array(firstDayOfMonth).fill(null).concat(Array.from({ length: daysInMonth }, (_, i) => i + 1));

                        db.query('SELECT DAY(appointment_date) as day, COUNT(*) as count FROM appointments WHERE YEAR(appointment_date) = ? AND MONTH(appointment_date) = ? AND admin_id = ? AND status IN ("pending", "ongoing", "completed") GROUP BY DAY(appointment_date)', [new Date(date).getFullYear(), new Date(date).getMonth() + 1, adminId], (err, appointmentDays) => {
                            const appointmentsMap = {};
                            if (!err && appointmentDays) appointmentDays.forEach(row => appointmentsMap[row.day] = row.count);

                            db.query(
                                `SELECT a.id, a.user_id, a.first_name, a.last_name, a.gender, a.phone_number, a.age, a.location, 
                                        a.appointment_date, a.appointment_time, ad.doctor_name, a.status, a.token_number, a.prescription 
                                 FROM appointments a 
                                 JOIN admins ad ON a.admin_id = ad.id 
                                 WHERE a.admin_id = ? AND a.status = "completed" 
                                 ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
                                [adminId],
                                (err, patients) => {
                                    if (err) {
                                        console.error('Error fetching previous patients:', err);
                                        patients = [];
                                    }
                                    res.render('admin-dashboard', { 
                                        admin, 
                                        totalVisits, 
                                        newPatients, 
                                        oldPatients, 
                                        ongoingAppointments: err ? [] : ongoingAppointments, 
                                        upcomingAppointments: err ? [] : upcomingAppointments, 
                                        patients: patients || [], 
                                        calendar: { year: new Date(date).getFullYear(), month: new Date(date).getMonth() + 1, days: calendarDays, today: new Date(date).getDate(), appointments: appointmentsMap }, 
                                        error: null, 
                                        selectedDate: date 
                                    });
                                }
                            );
                        });
                    });
                });
            });
        });
    });
});

router.get('/visits', isAdminAuthenticated, (req, res) => {
    const adminId = req.session.adminId;
    const date = getDate(req.query.date || null);

    db.query('SELECT doctor_name FROM admins WHERE id = ?', [adminId], (err, adminResults) => {
        if (err || adminResults.length === 0) {
            console.error('Error fetching admin details:', err);
            return res.status(500).json({ success: false, message: 'Error fetching admin details', error: err?.message });
        }
        const doctorName = adminResults[0].doctor_name;

        Promise.all([
            new Promise(resolve => db.query('SELECT COUNT(*) as total FROM appointments WHERE appointment_date = ? AND admin_id = ?', [date, adminId], (err, results) => resolve(err ? 0 : results[0].total))),
            new Promise(resolve => db.query('SELECT COUNT(*) as completed FROM appointments WHERE appointment_date = ? AND admin_id = ? AND status = "completed"', [date, adminId], (err, results) => resolve(err ? 0 : results[0].completed))),
            new Promise(resolve => db.query('SELECT COUNT(DISTINCT user_id) as new_patients FROM appointments WHERE appointment_date = ? AND admin_id = ? AND user_id IN (SELECT user_id FROM appointments GROUP BY user_id HAVING COUNT(*) = 1)', [date, adminId], (err, results) => resolve(err ? 0 : results[0].new_patients)))
        ]).then(([totalVisits, completedVisits, newPatients]) => {
            const oldPatients = totalVisits - newPatients;
            db.query('SELECT id, first_name, last_name, appointment_time FROM appointments WHERE appointment_date = ? AND admin_id = ? AND status = "completed" ORDER BY appointment_time DESC LIMIT 10', [date, adminId], (err, completedDetails) => {
                res.status(200).json({
                    success: true,
                    stats: { totalVisits, completedVisits, pendingVisits: totalVisits - completedVisits, newPatients, oldPatients, completionRate: totalVisits > 0 ? Math.round((completedVisits / totalVisits) * 100) : 0 },
                    recentCompleted: err ? [] : completedDetails
                });
            });
        }).catch(err => {
            console.error('Error fetching visit statistics:', err);
            res.status(500).json({ success: false, message: 'Error fetching visit statistics', error: err.message });
        });
    });
});

router.get('/patient-details/:appointmentId', isAdminAuthenticated, (req, res) => {
    const appointmentId = req.params.appointmentId;

    db.query(
        `SELECT a.id, a.user_id, a.first_name, a.last_name, a.gender, a.phone_number, a.age, a.location, 
                a.appointment_date, a.appointment_time, ad.doctor_name, a.status, a.token_number 
         FROM appointments a 
         JOIN admins ad ON a.admin_id = ad.id 
         WHERE a.id = ?`,
        [appointmentId],
        (err, results) => {
            if (err) {
                console.error('Error fetching patient details:', err);
                return res.status(500).json({ success: false, message: 'Error fetching patient details', error: err.message });
            }
            if (results.length === 0) return res.status(404).json({ success: false, message: 'Appointment not found' });
            const patient = results[0];

            if (!patient.token_number) {
                db.query(
                    'SELECT COUNT(*) as count FROM appointments WHERE appointment_date = ? AND admin_id = ? AND status = "pending" AND id <= ?',
                    [patient.appointment_date, patient.admin_id, patient.id],
                    (err, tokenResult) => {
                        if (err) {
                            console.error('Error generating token number:', err);
                            return res.status(500).json({ success: false, message: 'Error generating token number', error: err.message });
                        }
                        const tokenNumber = tokenResult[0].count;
                        db.query('UPDATE appointments SET token_number = ? WHERE id = ?', [tokenNumber, patient.id], (err) => {
                            if (err) {
                                console.error('Error updating token number:', err);
                                return res.status(500).json({ success: false, message: 'Error updating token number', error: err.message });
                            }
                            patient.token_number = tokenNumber;
                            res.status(200).json({ success: true, patient });
                        });
                    }
                );
            } else {
                res.status(200).json({ success: true, patient });
            }
        }
    );
});

router.get('/previous-patients', isAdminAuthenticated, (req, res) => {
    const adminId = req.session.adminId;

    db.query('SELECT id FROM admins WHERE id = ?', [adminId], (err, adminResults) => {
        if (err || adminResults.length === 0) {
            console.error('Error fetching admin details:', err);
            return res.status(500).json({ success: false, message: 'Error fetching admin details', error: err?.message });
        }
        db.query(
            `SELECT a.id, a.user_id, a.first_name, a.last_name, a.gender, a.phone_number, a.age, a.location, 
                    a.appointment_date, a.appointment_time, ad.doctor_name, a.status, a.token_number, a.prescription 
             FROM appointments a 
             JOIN admins ad ON a.admin_id = ad.id 
             WHERE a.admin_id = ? AND a.status = "completed" 
             ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
            [adminId],
            (err, results) => {
                if (err) {
                    console.error('Error fetching previous patients:', err);
                    return res.status(500).json({ success: false, message: 'Error fetching previous patients', error: err.message });
                }
                res.status(200).json({ success: true, patients: results });
            }
        );
    });
});

router.get('/prescription/:appointmentId', isAdminAuthenticated, (req, res) => {
    const appointmentId = req.params.appointmentId;

    db.query(
        `SELECT a.prescription, a.first_name, a.last_name, a.age, a.gender, 
                ad.doctor_name, ad.hospital_name, ad.license_number, ad.location
         FROM appointments a
         JOIN admins ad ON a.admin_id = ad.id
         WHERE a.id = ?`,
        [appointmentId],
        (err, results) => {
            if (err) {
                console.error('Error fetching prescription:', err);
                return res.status(500).json({ success: false, message: 'Error fetching prescription', error: err.message });
            }
            if (results.length === 0) {
                return res.status(404).json({ success: false, message: 'Appointment not found' });
            }
            const row = results[0];
            console.log('Fetched prescription data:', row);
            if (!row.prescription || row.prescription.trim() === '') {
                return res.status(404).json({ success: false, message: 'No prescription available for this appointment' });
            }
            res.status(200).json({
                success: true,
                prescription: row.prescription,
                patientInfo: { name: `${row.first_name} ${row.last_name}`, age: row.age, gender: row.gender },
                doctorInfo: { name: row.doctor_name, hospital: row.hospital_name, license: row.license_number }
            });
        }
    );
});

router.get('/prescription-pdf/:appointmentId', isAdminAuthenticated, (req, res) => {
    const appointmentId = req.params.appointmentId;

    db.query(
        `SELECT a.prescription, a.first_name, a.last_name, a.age, a.gender, 
                ad.doctor_name, ad.hospital_name, ad.location, ad.license_number
         FROM appointments a
         JOIN admins ad ON a.admin_id = ad.id
         WHERE a.id = ?`,
        [appointmentId],
        (err, results) => {
            if (err || results.length === 0) {
                console.error('Error generating PDF:', err);
                return res.status(500).send('Error generating PDF');
            }
            const row = results[0];
            if (!row.prescription) {
                console.log('No prescription found for appointment:', appointmentId);
                return res.status(404).send('No prescription available for download');
            }

            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            res.setHeader('Content-Disposition', `attachment; filename="prescription_${appointmentId}.pdf"`);
            res.setHeader('Content-Type', 'application/pdf');
            doc.pipe(res);

            doc.fontSize(20).text('Prescription', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Patient: ${row.first_name} ${row.last_name}`);
            doc.text(`Age: ${row.age || 'N/A'}, Gender: ${row.gender || 'N/A'}`);
            doc.text(`Doctor: ${row.doctor_name}`);
            doc.text(`Hospital: ${row.hospital_name}, Location: ${row.location}`);
            doc.text(`License Number: ${row.license_number}`);
            doc.text(`Date: ${new Date().toLocaleDateString()}`);
            doc.moveDown();
            doc.text('Prescription Details:', { underline: true });
            doc.text(row.prescription || 'No prescription details available', { align: 'left' });

            doc.end();
        }
    );
});

router.post('/logout', isAdminAuthenticated, (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error during logout:', err);
            return res.status(500).json({ success: false, message: 'Logout failed', error: err.message });
        }
        res.clearCookie('connect.sid');
        res.status(200).json({ success: true, message: 'Logged out successfully' });
    });
});

router.get('/search-patients', isAdminAuthenticated, (req, res) => {
    const adminId = req.session.adminId;
    const query = req.query.query;

    if (!query || query.length < 2) {
        return res.status(400).json({ success: false, message: 'Query must be at least 2 characters long' });
    }

    db.query('SELECT id FROM admins WHERE id = ?', [adminId], (err, adminResults) => {
        if (err || adminResults.length === 0) {
            console.error('Error fetching admin details:', err);
            return res.status(500).json({ success: false, message: 'Error fetching admin details', error: err?.message });
        }

        const searchQuery = `%${query}%`;

        const sqlQuery = `
            SELECT DISTINCT a.id, a.first_name, a.last_name, a.phone_number, a.gender, a.age, a.location,
                            a.appointment_date, a.appointment_time, a.token_number, a.status, a.prescription
            FROM appointments a
            WHERE a.admin_id = ?
            AND (a.first_name LIKE ? OR a.last_name LIKE ? OR CONCAT(a.first_name, ' ', a.last_name) LIKE ?)
        `;

        db.query(sqlQuery, [adminId, searchQuery, searchQuery, searchQuery], (err, results) => {
            if (err) {
                console.error('Error searching patients:', err);
                return res.status(500).json({ success: false, message: 'Error searching patients', error: err.message });
            }
            res.status(200).json({ success: true, patients: results });
        });
    });
});

module.exports = router;