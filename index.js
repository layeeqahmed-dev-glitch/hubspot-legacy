require('dotenv').config();
const express = require("express");
const app = express();
app.use(express.json());
const axios = require("axios");
const qs = require("querystring");
const connectDB = require('./db');
const Meeting = require('./models/meetings');
const convertHubspotTimezone = require('./timezoneMap');
const Token = require('./models/Token');
const session = require('express-session');

connectDB();
app.use(express.text({ type: "*/*" }));

let lastExecutionTime = 0;


app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // ✅ keep false for ngrok/http
}));


app.get('/', (req, res) => {
  res.send('Server is responding!');
});

// Step 1: HubSpot OAuth Callback
app.get('/callback', async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.status(400).send('No code provided!');
    }

    const tokenResponse = await axios.post(
      'https://api.hubapi.com/oauth/v1/token',
      qs.stringify({
        grant_type: 'authorization_code',
        client_id: process.env.HUBSPOT_CLIENT_ID,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET,
        redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
        code: code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const hubspotAccessToken = tokenResponse.data.access_token;
    const hubspotRefreshToken = tokenResponse.data.refresh_token;

    // ✅ Get portalId from HubSpot
    const portalRes = await axios.get(`https://api.hubapi.com/oauth/v1/access-tokens/${hubspotAccessToken}`);
    const portalId = portalRes.data.hub_id;

    console.log('✅ HubSpot token saved for portal:', portalId);

    // ✅ Save in DB as pending
    await Token.findOneAndUpdate(
      { hubspotPortalId: portalId },
      {
        hubspotAccessToken,
        hubspotRefreshToken,
        status: 'pending'
      },
      { upsert: true, new: true }
    );

    // ✅ Keep session as backup
    req.session.portalId = portalId;

    // ✅ Redirect to MeetHour login
    const meethourRedirect = `${process.env.APP_BASE_URL}/meethour-callback`;

    res.redirect(
      `https://portal.meethour.io/serviceLogin?client_id=0pvx3tst84t7x3kym5wyvstnvol679mwmovk&redirect_uri=${encodeURIComponent(meethourRedirect)}&device_type=web&response_type=get`
    );

  } catch (err) {
    console.error('OAuth Error:', err.response?.data || err.message);
    res.status(500).send('Installation failed!');
  }
});


// Step 2: MeetHour Callback — portalId comes from URL param, not state
app.get('/meethour-callback', async (req, res) => {
  try {
    const token = req.query.access_token;

    if (!token) {
      return res.status(400).send('No MeetHour token found!');
    }

    // ✅ Find the most recent pending record
    const pendingRecord = await Token.findOne({ status: 'pending' }).sort({ createdAt: -1 });

    if (!pendingRecord) {
      return res.status(400).send('Session expired! Please reinstall the app.');
    }

    // ✅ Update with MeetHour token and mark as active
    await Token.findOneAndUpdate(
      { hubspotPortalId: pendingRecord.hubspotPortalId },
      { 
        meethourAccessToken: token,
        status: 'active' // ✅ now active!
      }
    );

    console.log('✅ MeetHour token saved for portal:', pendingRecord.hubspotPortalId);
    res.send('✅ MeetHour connected successfully! You can close this tab.');

  } catch (err) {
    console.error('MeetHour Callback Error:', err.message);
    res.status(500).send('Something went wrong!');
  }
});


//random password generator
function generatePasscode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let passcode = '';
  for (let i = 0; i < 7; i++) {
    passcode += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return passcode;
}


//creating webhook meeting from hubspot API
app.post("/create-meeting", async (req, res) => {
  try {
    console.log("------ NEW REQUEST ------");
    console.log("BODY:", JSON.stringify(req.body, null, 2));

    const now = Date.now();

    if (now - lastExecutionTime < 4000) {
      console.log("⚠️ Duplicate request blocked");
      return res.json({
        conferenceId: "dup-" + now,
        conferenceUrl: "https://meethour.io",
        conferenceDetails: "Duplicate request ignored"
      });
    }

    lastExecutionTime = now;

    const invitees = req.body.invitees || [];

    if (invitees.length === 0) {
      console.log("❌ No invitees");
      return res.json({
        conferenceId: "no-attendees-" + now,
        conferenceUrl: "https://meethour.io",
        conferenceDetails: "No attendees provided"
      });
    }

    // ✅ Get portalId from request
    const portalId = req.body.portalId;

    if (!portalId) {
      console.log("❌ No portalId in request");
      return res.json({
        conferenceId: "error-" + now,
        conferenceUrl: "https://meethour.io",
        conferenceDetails: "Portal ID missing"
      });
    }

    // ✅ Fetch MeetHour token from DB dynamically
    const tokenRecord = await Token.findOne({ hubspotPortalId: portalId });

    if (!tokenRecord || !tokenRecord.meethourAccessToken) {
      console.log("❌ No MeetHour token found for portal:", portalId);
      return res.json({
        conferenceId: "error-" + now,
        conferenceUrl: "https://meethour.io",
        conferenceDetails: "MeetHour not connected for this account"
      });
    }

    const token = tokenRecord.meethourAccessToken; // ✅ Dynamic token!

    const start = new Date(req.body.startTime);
    const meeting_date = start.toISOString().split("T")[0];

    let hours = start.getHours();
    const minutes = start.getMinutes();
    const meridiem = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;

    const meeting_time =
      `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

    const attend = invitees
      .filter(i => i?.email)
      .map(i => ({
        first_name: i.firstName || "Client",
        last_name: i.lastName || "",
        email: i.email
      }));

    const payload = {
      meeting_name: req.body.topic || "HubSpot Meeting",
      meeting_date,
      meeting_time,
      meeting_meridiem: meridiem,
      timezone: convertHubspotTimezone(req.body.timezone),
      passcode: generatePasscode(),
      attend,
      send_calendar_invite: 1
    };

    const response = await axios.post(
      "https://api.meethour.io/api/v1.2/meeting/schedulemeeting",
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    const meeting = response.data.data;

    const formattedTime = new Date(req.body.startTime).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    });

    //Meeting details that will shown in the meetings tab in hubspot
    const details = `
      Layeeq Ahmed is inviting you to a scheduled meeting.
      Topic: ${meeting.topic}
      Time: ${formattedTime} (${convertHubspotTimezone(req.body.timezone)})
      Join Meeting: ${meeting.joinURL}
      Meeting ID: ${meeting.meeting_id}
      Passcode: ${meeting.passcode}`;

    await Meeting.create({
      hubspotMeetingId: `${req.body.portalId}-${req.body.startTime}`,
      hubspotPortalId: portalId,
      meethourMeetingId: meeting.meeting_id,
      meethourMeetingUrl: meeting.joinURL,
      meetingName: req.body.topic || "HubSpot Meeting",
      conferenceId: String(meeting.id)  // ✅ save conferenceId
    });

    console.log('Meeting saved to DB! ✅');

    return res.json({
      conferenceId: meeting.id,
      conferenceUrl: meeting.joinURL,
      conferenceDetails: details
    });

  } catch (err) {
    console.log("ERROR:", err.response?.data || err.message);
    return res.json({
      conferenceId: "error-" + Date.now(),
      conferenceUrl: "https://meethour.io",
      conferenceDetails: "Temporary issue, try again"
    });
  }
});


// delete meeting route

app.post("/delete-meeting", async (req, res) => {
  try {
    console.log("------ DELETE MEETING REQUEST ------");
    console.log("BODY:", JSON.stringify(req.body, null, 2));

    const portalId = req.body.portalId;
    const conferenceId = req.body.conferenceId; // ✅ get conferenceId

    if (!portalId) {
      console.log("❌ No portalId found");
      return res.status(400).send('Portal ID missing');
    }

    if (!conferenceId) {
      console.log("❌ No conferenceId found");
      return res.status(400).send('Conference ID missing');
    }

    // ✅ Fetch MeetHour token from DB
    const tokenRecord = await Token.findOne({ hubspotPortalId: String(portalId) });

    if (!tokenRecord || !tokenRecord.meethourAccessToken) {
      console.log("❌ No MeetHour token found for portal:", portalId);
      return res.status(400).send('MeetHour not connected for this account');
    }

    const token = tokenRecord.meethourAccessToken;

    // ✅ Find meeting by conferenceId
    const meetingRecord = await Meeting.findOne({ conferenceId: String(conferenceId) });

    if (!meetingRecord) {
      console.log("❌ Meeting not found in DB");
      return res.status(404).send('Meeting not found');
    }

    console.log("✅ Found meeting in DB:", meetingRecord.meethourMeetingId);

    // ✅ Call MeetHour delete API
    const response = await axios.post(
      "https://api.meethour.io/api/v1.2/meeting/deletemeeting",
      { meeting_id: meetingRecord.meethourMeetingId },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Meeting deleted from MeetHour:", response.data);

    // ✅ Delete from DB as well
    await Meeting.findOneAndDelete({ conferenceId: String(conferenceId) });

    console.log("✅ Meeting deleted from DB!");

    return res.status(200).send('Meeting deleted successfully!');

  } catch (err) {
    console.error("Delete Meeting Error:", err.response?.data || err.message);
    return res.status(500).send('Something went wrong!');
  }
});

//localhost running @ 3000
app.listen(3000, () => console.log("Server running"));
module.exports = app;