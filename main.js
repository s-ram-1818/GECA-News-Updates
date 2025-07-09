// --- Dependencies ---
const express = require("express");
const bodyParser = require("body-parser");
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
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

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
  service: "gmail",
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
      callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, profile);
    }
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
    res.render("index", {
      news,
      message: req.query.message,
    });
  } catch (e) {
    res.status(500).send("Failed to load news");
  }
});

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["email"],
  })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/subscribe-fail" }),
  async (req, res) => {
    res.redirect("/verify-email");
  }
);

app.get("/subscribe-fail", (req, res) => {
  redirectWithMessage(res, "<h2>❌ Subscription Failed</h2>");
});

app.get("/api/news", async (req, res) => {
  try {
    const news = await News.find().lean();
    res.send(news);
  } catch (e) {
    res.status(500).json({ message: "Failed to load news" });
  }
});

app.get("/api/sends", async (req, res) => {
  try {
    const sends = await Subscriber.find().lean();
    res.send(sends);
  } catch (e) {
    res.status(500).json({ message: "Failed to load subscribers" });
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

app.get("/verify-email", ensureAuth, async (req, res) => {
  const email = req.user.emails[0].value;
  try {
    const user = await Subscriber.findOne({ email });
    if (user) return redirectWithMessage(res, "You are already subscribed!");

    await new Subscriber({ email }).save();

    const unsubscribeToken = jwt.sign(
      { email },
      process.env.JWT_SECRET || "your_jwt_secret",
      { expiresIn: "15m" }
    );
    const unsubscribeLink = `${BASE_URL}/unsubscribe?token=${unsubscribeToken}`;
    const welcomeText = `
Welcome to GECA News Updates 📢

Hi there,

We're excited to have you on board! You've successfully subscribed to receive the latest updates, announcements, and important news from Government College of Engineering, Aurangabad (GECA).

We'll make sure you're always in the loop.

If you ever wish to unsubscribe, you can do so using the link below:
Unsubscribe: ${unsubscribeLink}

Regards,  
GECA News Team  
Government College of Engineering, Aurangabad
`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Welcome to GECA News Updates!",
      text: welcomeText,
      html: `
  <h3>Welcome to GECA News Updates 📢</h3>
  <p>Hi there,</p>
  <p>We're excited to have you on board! You've successfully subscribed to receive the latest updates, announcements, and important news from <strong>Government College of Engineering, Aurangabad (GECA)</strong>.</p>
  <p>We'll make sure you're always in the loop.</p>
  <p>If you ever wish to unsubscribe, you can do so by clicking the link below:</p>
  <p><a href="${unsubscribeLink}">Unsubscribe</a></p>
  <p>Regards,<br/>GECA News Team<br/>Government College of Engineering, Aurangabad</p>
`,
    };
    await transporter.sendMail(mailOptions);
    redirectWithMessage(res, "Subscription successful!");
  } catch {
    redirectWithMessage(res, "Subscription Failed!");
  }
});

// --- Scraper + Emailer ---
async function checkForNewNews() {
  console.log("Checking for new news...");

  let newsItems = [];
  let newNews = [];

  try {
    try {
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);

      $("ul.scrollNews li a").each((i, el) => {
        const title = $(el).text().trim();
        const href = $(el).attr("href").trim();
        const fullLink = new URL(href, url).href;
        newsItems.push({ title, link: fullLink });
      });
    } catch (err) {
      console.error("Failed to fetch news:", err.message);
      return;
    }

    const existingLinks = new Set(
      (await News.find({}, "link").lean()).map((n) => n.link)
    );
    newNews = newsItems.filter((n) => !existingLinks.has(n.link));
    if (!newNews.length) return;

    try {
      await News.deleteMany({});
      await News.insertMany(newsItems);
    } catch (err) {
      console.error("Failed to save news:", err.message);
    }

    const subs = await Subscriber.find({}, "email").lean();
    for (const { email } of subs) {
      const unsubscribeToken = jwt.sign(
        { email },
        process.env.JWT_SECRET || "your_jwt_secret",
        { expiresIn: "30d" }
      );
      const unsubscribeLink = `${BASE_URL}/unsubscribe?token=${unsubscribeToken}`;

      const bodyText = `
GECA News Updates 📰

Hi there,

Here are the latest updates from Government College of Engineering, Aurangabad (GECA):

${newNews.map((n, i) => `${i + 1}. ${n.title}\n${n.link}`).join("\n\n")}

You are receiving this email because you subscribed to GECA News Updates.

To unsubscribe: ${unsubscribeLink}

Regards,  
GECA News Team
`;

      const bodyHtml = `
  <h3>GECA News Updates 📰</h3>
  <p>Hi there,</p>
  <p>Here are the latest updates from <strong>Government College of Engineering, Aurangabad (GECA)</strong>:</p>
  <ol>
    ${newNews
      .map((n) => `<li><a href="${n.link}">${n.title}</a></li>`)
      .join("")}
  </ol>
  <p>You’re receiving this email because you subscribed to GECA News Updates.</p>
  <p>If you no longer wish to receive these emails, you can <a href="${unsubscribeLink}">unsubscribe here</a>.</p>
  <p>Regards,<br/>GECA News Team</p>
`;

      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject: "GECA News Update 📰",
          text: bodyText,
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
