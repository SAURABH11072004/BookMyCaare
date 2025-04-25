const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/db');
const PDFDocument = require('pdfkit');

router.get('/login', (req, res) => {
    res.sendFile('login.html', { root: 'public' });
});

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE email = ?', [username], async (err, results) => {
        if (err) return res.status(500).send('Server error');
        if (results.length === 0) return res.status(401).json({ success: false, message: 'Invalid username or password' });
        const isValidPassword = await bcrypt.compare(password, results[0].password);
        if (isValidPassword) {
            req.session.userId = results[0].id;
            res.status(200).json({ success: true, message: 'Login successful' });
        } else {
            res.status(401).json({ success: false, message: 'Invalid username or password' });
        }
    });
});

router.get('/home3.html', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.render('home3', { id: req.session.userId });
});

router.get('/profile', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const userId = req.session.userId;
    db.query('SELECT id, first_name, last_name, email, gender, phone_number, dob, location, photo FROM users WHERE id = ?', [userId], (err, results) => {
        if (err) return res.status(500).send('Server error');
        if (results.length > 0) res.render('profile', { user: results[0], id: req.session.userId });
        else res.status(404).send('User not found');
    });
});

router.post('/update-profile', (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).send('Unauthorized');
    const { gender, phone_number, dob, location, photo } = req.body;
    if (!gender || !phone_number || !dob || !location) return res.status(400).send('All fields are required');
    db.query('UPDATE users SET gender = ?, phone_number = ?, dob = ?, location = ?, photo = ? WHERE id = ?', [gender, phone_number, dob, location, photo || null, userId], (err) => {
        if (err) return res.status(500).send('Error updating profile');
        res.redirect(`/profile?userId=${userId}`);
    });
});

router.get('/create-appointment', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.query('SELECT id, doctor_name FROM admins', (err, doctors) => {
        if (err) return res.status(500).render('create-appointment', { doctors: [], error: 'Error fetching doctors' });
        res.render('create-appointment', { doctors, error: null });
    });
});

router.post('/submit-appointment', (req, res) => {
    const { first_name, last_name, gender, phone_number, age, location, appointment_date, appointment_time, doctor_name } = req.body;
    const userId = req.session.userId;

    if (!userId) return res.status(401).json({ success: false, message: 'You must be logged in to create an appointment' });
    if (!first_name || !last_name || !appointment_date || !appointment_time || !doctor_name) {
        return res.status(400).json({ success: false, message: 'First name, last name, appointment date, time, and doctor name are required' });
    }

    db.query('SELECT id FROM admins WHERE doctor_name = ?', [doctor_name], (err, adminResults) => {
        if (err) {
            console.error('Error fetching admin ID:', err);
            return res.status(500).json({ success: false, message: 'Error fetching admin details' });
        }
        if (adminResults.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid doctor name' });
        }
        const admin_id = adminResults[0].id;

        db.query(
            'INSERT INTO appointments (user_id, first_name, last_name, gender, phone_number, age, location, appointment_date, appointment_time, admin_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "pending")',
            [userId, first_name, last_name, gender, phone_number, age, location, appointment_date, appointment_time, admin_id],
            (err) => {
                if (err) {
                    console.error('Error inserting appointment:', err);
                    return res.status(500).json({ success: false, message: 'Error creating appointment: ' + err.message });
                }
                res.status(200).json({ success: true, message: 'Appointment created successfully' });
            }
        );
    });
});

router.get('/appointments', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const userId = req.session.userId;
    db.query('SELECT a.id, a.first_name, a.last_name, a.gender, a.phone_number, a.age, a.location, a.appointment_date, a.appointment_time, ad.doctor_name, a.status, a.prescription FROM appointments a JOIN admins ad ON a.admin_id = ad.id WHERE a.user_id = ?', [userId], (err, results) => {
        if (err) {
            console.error('Error fetching appointments:', err);
            return res.status(500).send('Server error');
        }
        res.render('appointments', { appointments: results });
    });
});

router.get('/prescription/:appointmentId', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const appointmentId = req.params.appointmentId;

    db.query('SELECT a.prescription, a.first_name, a.last_name, a.age, a.gender, a.appointment_date, ad.doctor_name, ad.hospital_name, ad.license_number FROM appointments a JOIN admins ad ON a.admin_id = ad.id WHERE a.id = ? AND a.user_id = ?', [appointmentId, req.session.userId], (err, results) => {
        if (err) {
            console.error('Error fetching prescription details:', err);
            return res.status(500).json({ success: false, message: 'Error fetching prescription details' });
        }
        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'Prescription not found or not authorized' });
        }
        const prescription = results[0];
        if (!prescription.prescription) {
            return res.status(404).json({ success: false, message: 'No prescription available' });
        }

        // Parse prescription if it's a string with comma-separated values or a JSON string
        let medicines = [];
        let notes = '';
        if (typeof prescription.prescription === 'string') {
            const lines = prescription.prescription.split('\n');
            medicines = lines.map(line => {
                const [name, dosage, duration, instructions] = line.split(',');
                return { name: name || 'N/A', dosage: dosage || 'N/A', duration: duration || 'N/A', instructions: instructions || 'N/A' };
            });
            notes = lines.length > 0 ? lines[lines.length - 1] : 'No additional notes';
        }

        res.json({
            success: true,
            first_name: prescription.first_name,
            last_name: prescription.last_name,
            age: prescription.age,
            gender: prescription.gender,
            appointment_date: prescription.appointment_date,
            doctor_name: prescription.doctor_name,
            hospital_name: prescription.hospital_name,
            license_number: prescription.license_number,
            prescription: {
                medicines: medicines,
                notes: notes
            }
        });
    });
});

router.get('/download-prescription/:appointmentId', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const appointmentId = req.params.appointmentId;

    db.query('SELECT a.prescription, a.first_name, a.last_name, a.age, a.gender, ad.doctor_name, ad.hospital_name, ad.license_number FROM appointments a JOIN admins ad ON a.admin_id = ad.id WHERE a.id = ? AND a.user_id = ?', [appointmentId, req.session.userId], (err, results) => {
        if (err) return res.status(500).send('Error fetching prescription details');
        if (results.length === 0) return res.status(404).send('Appointment not found');
        const prescription = results[0];
        if (!prescription.prescription) return res.status(404).send('No prescription available for download');

        const doc = new PDFDocument({ size: 'A5', margin: 50 });
        const fileName = `prescription_${appointmentId}.pdf`;
        res.setHeader('Content-disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);

        doc.fontSize(20).fillColor('#1a3c34').text('BookMyCare', 50, 30);
        doc.fontSize(16).fillColor('#1a3c34').text('Prescription', 50, 55);
        doc.fontSize(12).fillColor('#333').text(`Patient: ${prescription.first_name} ${prescription.last_name}`, 50, 90);
        doc.text(`Age: ${prescription.age || 'N/A'}`, 50, 110);
        doc.text(`Gender: ${prescription.gender || 'N/A'}`, 200, 110);
        doc.text(`Doctor: ${prescription.doctor_name}`, 50, 130);
        doc.text(`Date: ${new Date().toLocaleDateString()}`, 300, 90);
        doc.moveTo(50, 150).lineTo(450, 150).stroke();
        doc.fontSize(12).fillColor('#333').text('Prescription:', 50, 170);
        const prescriptionLines = prescription.prescription.split('\n');
        let yPos = 190;
        prescriptionLines.forEach((line, index) => {
            doc.text(`${index + 1}. ${line}`, 70, yPos);
            yPos += 20;
        });
        doc.fontSize(10).fillColor('#666').text('CLINIC NAME', 50, yPos + 30);
        doc.text('Pune', 50, yPos + 45);
        doc.end();
    });
});

router.post('/signup', async (req, res) => {
    const { first_name, last_name, email, gender, phone_number, dob, location, password } = req.body;

    if (!first_name || !last_name || !email || !gender || !phone_number || !dob || !location || !password) {
        return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    try {
        db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
            if (err) {
                console.error('Database error during email check:', err);
                return res.status(500).json({ success: false, message: 'Server error' });
            }
            if (results.length > 0) {
                return res.status(400).json({ success: false, message: 'Email already exists' });
            }

            bcrypt.hash(password, 10, (err, hashedPassword) => {
                if (err) {
                    console.error('Error hashing password:', err);
                    return res.status(500).json({ success: false, message: 'Error processing password' });
                }

                db.query(
                    'INSERT INTO users (first_name, last_name, email, gender, phone_number, dob, location, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [first_name, last_name, email, gender, phone_number, dob, location, hashedPassword],
                    (err) => {
                        if (err) {
                            console.error('Error inserting user:', err);
                            return res.status(500).json({ success: false, message: 'Error during signup' });
                        }
                        res.status(200).json({ success: true, message: 'Sign-up successful' });
                    }
                );
            });
        });
    } catch (error) {
        console.error('Unexpected error during signup:', error);
        res.status(500).json({ success: false, message: 'Error during signup' });
    }
});

module.exports = router;