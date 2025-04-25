function formatPrescription(medicines, notes, patientInfo, doctorInfo) {
    const formattedMedicines = medicines.map(med => 
      `${med.name}${med.dosage ? ` (${med.dosage})` : ''}${med.duration ? ` - ${med.duration}` : ''}${med.instructions ? ` - ${med.instructions}` : ''}`
    ).join('\n');
  
    return `
      Hospital: ${doctorInfo.hospitalName}
      Location: ${doctorInfo.location}
      Doctor: ${doctorInfo.doctorName}
      License: ${doctorInfo.licenseNumber}
      
      Patient: ${patientInfo.firstName} ${patientInfo.lastName}
      Age: ${patientInfo.age || 'N/A'}
      Gender: ${patientInfo.gender || 'N/A'}
      
      Prescription:
      ${formattedMedicines}
      
      Notes: ${notes || 'None'}
      
      Date: ${new Date().toLocaleDateString()}
    `.trim();
  }
  
  module.exports = { formatPrescription };