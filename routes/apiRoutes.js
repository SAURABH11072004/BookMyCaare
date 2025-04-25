const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/db');

router.get('/medicine-suggestions', async (req, res) => {
  try {
    const { query } = req.query;

    // Validate query parameter
    if (!query || typeof query !== 'string' || query.trim() === '') {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    // Step 1: Query the Render API as the primary source
    const renderApiUrl = `https://medicine-api-lks6.onrender.com/api/medicines/suggest?query=${encodeURIComponent(query.trim())}&limit=10`;
    const renderResponse = await axios.get(renderApiUrl);

    const localResults = renderResponse.data.suggestions.map(item => ({
      name: item.name || 'Unknown',
      price: item.price || 'N/A',
      manufacturer_name: item.manufacturer_name || 'Unknown',
      dosage: '', // Render API doesn't provide dosage, default to empty
      description: '', // Render API doesn't provide description, default to empty
      pack_size_label: item.pack_size_label || 'N/A'
    }));

    // Step 2: Insert Render API results into the local database
    if (localResults.length > 0) {
      await Promise.all(localResults.map(med => new Promise((resolve) => {
        db.query(
          'INSERT INTO medicines (name, dosage, description, price, manufacturer_name, pack_size_label) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=name',
          [med.name, med.dosage, med.description, med.price, med.manufacturer_name, med.pack_size_label],
          resolve
        );
      })));
      return res.json(localResults);
    }

    // Step 3: If no results from Render API, fallback to FDA API
    const fdaApiUrl = `https://api.fda.gov/drug/label.json?search=openfda.brand_name:${encodeURIComponent(query)}*&limit=10`;
    const fdaResponse = await axios.get(fdaApiUrl);
    const medicines = fdaResponse.data.results.map(item => ({
      name: item.openfda?.brand_name?.[0] || 'Unknown',
      dosage: item.dosage_and_administration?.[0]?.substring(0, 100) || '',
      description: item.description?.[0]?.substring(0, 200) || '',
      price: 'N/A', // FDA API doesn't provide price
      manufacturer_name: item.openfda?.manufacturer_name?.[0] || 'Unknown',
      pack_size_label: 'N/A' // FDA API doesn't provide pack size
    }));

    // Step 4: Insert FDA results into local database
    await Promise.all(medicines.map(med => new Promise((resolve) => {
      db.query(
        'INSERT INTO medicines (name, dosage, description, price, manufacturer_name, pack_size_label) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=name',
        [med.name, med.dosage, med.description, med.price, med.manufacturer_name, med.pack_size_label],
        resolve
      );
    })));

    // Step 5: Return the FDA results
    res.json(medicines);
  } catch (error) {
    console.error('Medicine search error:', error.message);
    if (error.response) {
      // Handle API-specific errors (e.g., 404, 500 from Render or FDA)
      return res.status(error.response.status).json({ error: `Failed to fetch from API: ${error.response.statusText}` });
    }
    res.status(500).json({ error: 'Failed to search medicines' });
  }
});

module.exports = router;