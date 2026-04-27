const mongoose = require('mongoose');

const MeetingSchema = new mongoose.Schema({
  hubspotMeetingId: {
    type: String,
    required: true
  },
  hubspotPortalId: {
    type: String,
    required: true
  },
  meethourMeetingId: {
    type: String,
    required: true
  },
  meethourMeetingUrl: {
    type: String,
    required: true
  },
  meetingName: {
    type: String
  },
  conferenceId: {
    type: String,  // ✅ added to find meeting on delete/update
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Meeting', MeetingSchema);