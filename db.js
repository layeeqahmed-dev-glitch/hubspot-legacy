const mongoose = require('mongoose');

let isConnected = false; 

const connectDB = async () => {
  if (isConnected) {
    console.log('=> Using existing database connection');
    return;
  }

  // ✅ Only connect if MONGO_URI exists
  if (!process.env.MONGO_URI) {
    console.warn('⚠️ MONGO_URI not set - running without database');
    return;
  }

  try {
    const db = await mongoose.connect(process.env.MONGO_URI);
    isConnected = db.connections[0].readyState;
    console.log('MongoDB Connected! ✅');
  } catch (error) {
    console.warn('⚠️ MongoDB connection failed:', error.message);
    console.warn('⚠️ App will run without database');
    // Don't throw - let app continue
  }
};

module.exports = connectDB;