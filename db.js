const mongoose = require('mongoose');

// This variable will persist across different requests 
// if the serverless function stays "warm"
let isConnected = false; 

const connectDB = async () => {
  if (isConnected) {
    console.log('=> Using existing database connection');
    return;
  }

  try {
    const db = await mongoose.connect(process.env.MONGO_URI);
    
    // Check if the connection is successful (state 1 means connected)
    isConnected = db.connections[0].readyState;
    
    console.log('MongoDB Connected! ✅');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    // Don't use process.exit(1) on Vercel; it will crash the function.
    throw error; 
  }
};

module.exports = connectDB;