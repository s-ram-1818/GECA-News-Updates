//this is a test version that is being pushed
// --- Dependencies ---
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const connectDB = require("./connection.js");
const { News, Subscriber } = require("./schema.js");
const jwt = require("jsonwebtoken");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const https = require("https");

dotenv.config();

const app = express();
const url = "https://geca.ac.in/";
const PORT = process.env.PORT || 4231;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// --- Middleware ---
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// --- Mail Transporter ---
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// --- DB Connection ---
(async () => {
  try {
    await connectDB();
  } catch (error) {
    console.error("Database connection failed:", error.message);
  }
})();

// --- View Engine ---
app.set("view engine", "ejs");

// --- Session & Passport Setup ---
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${BASE_URL}/auth/google/callback`,
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);

// --- Helpers ---
function redirectWithMessage(res, message) {
  res.redirect("/?message=" + encodeURIComponent(message));
}
function ensureAuth(req, res, next) {
  if (!req.user) return res.redirect("/auth/google");
  next();
}

// --- Routes ---
app.get("/", async (req, res) => {
  try {
    const news = await News.find().lean();
    res.render("index", { news, message: req.query.message });
  } catch (e) {
    res.status(500).send("Failed to load news");
  }
});

// --- Google OAuth Routes ---
app.get("/auth/google", passport.authenticate("google", { scope: ["email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/subscribe-fail" }),
  async (req, res) => {
    const email = req.user.emails[0].value;
    try {
      const user = await Subscriber.findOne({ email });
      if (user) return redirectWithMessage(res, "You are already subscribed!");

      await new Subscriber({ email }).save();

      const unsubscribeToken = jwt.sign(
        { email },
        process.env.JWT_SECRET || "your_jwt_secret",
        { expiresIn: "30d" }
      );
      const unsubscribeLink = `${BASE_URL}/unsubscribe?token=${unsubscribeToken}`;

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Welcome to GECA News Updates!",
        html: `
          <h3>Welcome to GECA News Updates 📢</h3>
          <p>Hi there,</p>
          <p>You've successfully subscribed to receive updates from <strong>Government College of Engineering, Aurangabad (GECA)</strong>.</p>
          <p>If you wish to unsubscribe, click below:</p>
          <p><a href="${unsubscribeLink}">Unsubscribe</a></p>
          <p>Regards,<br/>GECA News Team</p>
        `,
      };
      await transporter.sendMail(mailOptions);
      redirectWithMessage(res, "Subscription successful!");
    } catch {
      redirectWithMessage(res, "Subscription Failed!");
    }
  }
);

app.get("/subscribe-fail", (req, res) => {
  redirectWithMessage(res, "Subscription Failed");
});

app.get("/api/news", async (req, res) => {
  try {
    const news = await News.find().lean();
    res.send(news);
  } catch {
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
    await Subscriber.deleteOne({ email: decoded.email });
    redirectWithMessage(res, "You are unsubscribed successfully!");
  } catch {
    redirectWithMessage(res, "Invalid or expired token.");
  }
});

// --- Scraper (with Render-compatible Proxy Fallback) ---
async function checkForNewNews() {
  console.log("Checking for new news...");
  const agent = new https.Agent({ rejectUnauthorized: false });
  let newsItems = [];

  try {
    let data;

    try {
      // Try direct fetch
      const response = await axios.get(url, {
        httpsAgent: agent,
        timeout: 8000,
      });
      data = response.data;
    } catch (err) {
      // Fallback to proxy if Render blocks invalid SSL
      console.warn("Direct fetch failed, retrying with proxy...");
      const proxyURL = `https://api.allorigins.win/raw?url=${encodeURIComponent(
        url
      )}`;
      const response = await axios.get(proxyURL);
      data = response.data;
    }

    const $ = cheerio.load(data);
    $("ul.scrollNews li a").each((i, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr("href")?.trim();
      if (title && href) {
        const fullLink = new URL(href, url).href;
        newsItems.push({ title, link: fullLink });
      }
    });

    const existingLinks = new Set(
      (await News.find({}, "link").lean()).map((n) => n.link)
    );
    const newNews = newsItems.filter((n) => !existingLinks.has(n.link));

    if (!newNews.length) {
      console.log("No new news found.");
      return;
    }

    await News.deleteMany({});
    await News.insertMany(newsItems);
    console.log(`🆕 Found ${newNews.length} new news items.`);

    // Send updates to all subscribers
    const subs = await Subscriber.find({}, "email").lean();
    for (const { email } of subs) {
      const unsubscribeToken = jwt.sign(
        { email },
        process.env.JWT_SECRET || "your_jwt_secret",
        { expiresIn: "30d" }
      );
      const unsubscribeLink = `${BASE_URL}/unsubscribe?token=${unsubscribeToken}`;

      const bodyHtml = `
        <h3>GECA News Updates 📰</h3>
        <p>Hi there,</p>
        <p>Here are the latest updates from <strong>Government College of Engineering, Aurangabad (GECA)</strong>:</p>
        <ol>
          ${newNews
            .map((n) => `<li><a href="${n.link}">${n.title}</a></li>`)
            .join("")}
        </ol>
        <p>If you no longer wish to receive these emails, you can <a href="${unsubscribeLink}">unsubscribe here</a>.</p>
        <p>Regards,<br/>GECA News Team</p>
      `;

      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject: "GECA News Update 📰",
          html: bodyHtml,
        });
      } catch (err) {
        console.error(`Failed to send to ${email}:`, err.message);
      }
    }
  } catch (err) {
    console.error("News scraping failed:", err.message);
  }
}

// --- Cron Job (Every 3 min) ---
cron.schedule("*/3 * * * *", checkForNewNews);

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`✅ Server running on ${BASE_URL}`);
});
