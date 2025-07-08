// --- Dependencies ---
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const connectDB = require("./connection.js");
const { News, Subscriber } = require("./schema.js");
const jwt = require("jsonwebtoken");
const dns = require("dns");
const { Domain } = require("domain");
const rateLimit = require("express-rate-limit");

dotenv.config();

// --- App & Config ---
const app = express();
const url = "https://geca.ac.in/";
const PORT = process.env.PORT || 4231;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 100 requests per 15 minutes
  message: "Too many requests from this IP. Please try again after 15 minutes.",
});

// --- Mail Transporter ---
// check Domain
app.use(globalLimiter); // <-- apply globally
app.use(
  "/subscribe",
  rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: "Too many subscription attempts. Please wait.",
  })
);
dns.setServers(["8.8.8.8"]);

function checkEmailDomain(email) {
  return new Promise((resolve, reject) => {
    const domain = email.split("@")[1];

    if (!domain) return reject("Invalid email format");

    dns.resolveMx(domain, (err, addresses) => {
      if (err || addresses.length === 0) {
        return reject("Domain cannot receive emails");
      }
      resolve("Domain is valid");
    });
  });
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// --- Database Connection ---
(async () => {
  try {
    await connectDB();
  } catch (error) {
    console.error("Database connection failed:", error.message);
  }
})();

// --- Middleware ---
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

// --- Helper: redirect to home with message in query string
function redirectWithMessage(res, message) {
  res.redirect("/?message=" + encodeURIComponent(message));
}

// --- Routes ---

// Home page
app.get("/", async (req, res) => {
  console.log("Home page accessed");
  try {
    const news = await News.find().lean();
    // Get message from query string if present
    const message = req.query.message;
    res.render("index", {
      news,
      message,
      siteKey: process.env.RECAPTCHA_SITE_KEY,
    });
  } catch (e) {
    console.error("Failed to load news:", e);
    res.status(500).send("Server error");
  }
});

// API: Get all news
app.get("/api/news", async (req, res) => {
  try {
    const news = await News.find().lean();
    res.send(news);
  } catch (e) {
    res.status(500).json({ message: "Failed to load news" });
  }
});

// API: Get all subscribers
app.get("/api/sends", async (req, res) => {
  try {
    const sends = await Subscriber.find().lean();
    res.send(sends);
  } catch (e) {
    console.error("Invalid news file:", e);
    res.status(500).json({ message: "Failed to load news" });
  }
});

app.get("/unsubscribe", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("Missing token.");
  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your_jwt_secret"
    );
    const email = decoded.email;
    await Subscriber.deleteOne({ email });
    redirectWithMessage(res, "You are unsubscribed successfully!");
  } catch (err) {
    redirectWithMessage(res, "invalid or expired token. Please try again.");
  }
});

app.get("/verify-email", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("Missing token.");
  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your_jwt_secret"
    );
    const email = decoded.email;
    const user = await Subscriber.findOne({ email });
    if (user) {
      redirectWithMessage(res, "You are already subscribed!");
      return;
    }

    const subscriber = new Subscriber({ email });
    await subscriber.save();

    const newtoken = jwt.sign(
      { email },
      process.env.JWT_SECRET || "your_jwt_secret",
      { expiresIn: "15m" }
    );
    const verificationLink = `${BASE_URL}/unsubscribe?token=${token}`;
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "🎉 Welcome to GECA News Updates!",
      text: `Hi there,
Thank you for subscribing to GECA News Updates.
You'll now receive notifications whenever new notices or announcements are posted on the official GECA website.
📢 We promise: No spam — only relevant updates.

if you want to unsubscribe then click \n${verificationLink}\nvalid for 15 minutes.

Regards,  
GECA News Team`,
    };
    await transporter.sendMail(mailOptions);
    redirectWithMessage(res, "Subscription successful! ");
  } catch (err) {
    redirectWithMessage(res, "invalid or expired token. Please try again.");
  }
});

// Subscribe route
app.post("/subscribe", async (req, res) => {
  const email = req.body.email;
  const captchaToken = req.body["g-recaptcha-response"];
  if (!captchaToken) {
    return redirectWithMessage(res, "Please complete the CAPTCHA.");
  }

  if (!email) {
    redirectWithMessage(res, "Email is required");
    return;
  }

  try {
    const existing = await Subscriber.findOne({ email });
    if (existing) {
      redirectWithMessage(res, "You are already subscribed!");
      return;
    }
    // Check if the email domain is valid
    const verifyURL = `https://www.google.com/recaptcha/api/siteverify`;
    const params = new URLSearchParams({
      secret: process.env.RECAPTCHA_SECRET_KEY,
      response: captchaToken,
    });

    const { data } = await axios.post(verifyURL, params);

    if (!data.success) {
      return redirectWithMessage(res, "reCAPTCHA verification failed.");
    }
    await checkEmailDomain(email);
    const token = jwt.sign(
      { email },
      process.env.JWT_SECRET || "your_jwt_secret",
      { expiresIn: "15m" }
    );
    const verificationLink = `${BASE_URL}/verify-email?token=${token}`;
    const verifymail = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Verify your subscription to GECA News Updates 📧",
      text: `Please verify your email by clicking the link below:\n${verificationLink}\nvalid for 15 minutes.\n\nRegards,\nGECA News Team`,
    };
    transporter.sendMail(verifymail);
    let msg = `verificatin link sent to ${email}.\n
Please check your inbox. If you don't see it there, kindly check your spam folder.`;
    redirectWithMessage(
      res,
      `Verification link sent!
Please check your inbox. If you don't see it there, kindly check your spam folder.`
    );
  } catch (err) {
    console.error("Subscription error:", err);
    redirectWithMessage(res, "Subscription failed. Please try again later.");
  }
});

// --- News Scraper and Mailer ---
async function checkForNewNews() {
  console.log("Checking for new news...");
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const newsItems = [];
    $("ul.scrollNews li a").each((i, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr("href").trim();
      const fullLink = new URL(href, url).href;
      newsItems.push({ title, link: fullLink });
    });

    const existingLinks = new Set(
      (await News.find({}, "link").lean()).map((item) => item.link)
    );

    const newNews = newsItems.filter((item) => !existingLinks.has(item.link));

    if (!newNews.length) {
      return;
    }
    await News.deleteMany({});
    await News.insertMany(newsItems);

    const subs = await Subscriber.find({}, "email").lean();
    const emails = subs.map((sub) => sub.email);

    for (const email of emails) {
      const token = jwt.sign(
        { email },
        process.env.JWT_SECRET || "your_jwt_secret",
        { expiresIn: "15m" }
      );
      const verificationLink = `${BASE_URL}/unsubscribe?token=${token}`;

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email, // send only to one user
        subject: "GECA News Update 📰",
        text:
          newNews
            .map((item, i) => `${i + 1}. ${item.title}\n${item.link}`)
            .join("\n\n") +
          `\n\nIf you no longer wish to receive these updates, click here to unsubscribe:
          \n${verificationLink}\nvalid for 15 minutes.\n\nRegards,\nGECA News Team`,
      };

      try {
        await transporter.sendMail(mailOptions);
        // console.log(`Email sent to ${email}`);
      } catch (err) {
        console.error(`Failed to send to ${email}:`, err.message);
      }
    }
  } catch (error) {
    // Optionally log error
  }
}

// --- Scheduler ---
cron.schedule("*/3 * * * *", checkForNewNews); // Every 3 min

// --- Start Server ---
app.listen(PORT, () => {
  // Optionally log server start
});

// --- Scheduler ---
