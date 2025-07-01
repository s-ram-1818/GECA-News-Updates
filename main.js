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
dotenv.config();

// --- Constants ---
const app = express();
const STATE_FILE = path.join(__dirname, "news.json");
const SUBSCRIBERS_FILE = path.join(__dirname, "sends.json");
const url = "https://geca.ac.in/";
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "gecanewzz@gmail.com",
    pass: "qupd fkak gyyo eqao", // Replace with the App Password
  },
});

// --- Express Setup ---
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

// --- Express Routes ---
app.get("/", (req, res) => {
  let news = [];
  if (fs.existsSync(STATE_FILE)) {
    try {
      news = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch (e) {
      console.error("Invalid news file:", e);
    }
  }
  res.render("index", { news });
});

app.get("/api/news", (req, res) => {
  try {
    const data = fs.readFileSync(STATE_FILE, "utf8");
    const news = JSON.parse(data);
    res.send(news);
  } catch (err) {
    res.status(500).json({ message: "Failed to load news" });
  }
});

app.post("/subscribe", (req, res) => {
  const email = req.body.email;
  let emails = [];
  if (fs.existsSync(SUBSCRIBERS_FILE)) {
    try {
      emails = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, "utf8"));
    } catch (err) {
      console.error("Failed to read subscribers file:", err);
    }
  }
  if (!emails.includes(email)) {
    emails.push(email);
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(emails, null, 2), "utf8");
    const mailOptions = {
      from: "grcanewzz@gmail.com",
      to: email,
      subject: "Welcome to GECA News Updates 🎓",
      text: `Hi there,
Thank you for subscribing to GECA News Updates.
From now on, you'll receive email notifications whenever new notices or announcements are posted on the official GECA website. 
We send messages only when there’s something new — no spam.`,
    };
    transporter
      .sendMail(mailOptions)
      .catch((err) => console.error("Failed to send mail:", err));

    res.send("Successfully Registered");
  } else {
    res.send("Already Registered");
  }
});

// --- News Scraper and Mailer ---
async function checkForNewNews() {
  let x = [];
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
    if (fs.existsSync(STATE_FILE)) {
      const savedNews = fs.readFileSync(STATE_FILE, "utf8");
      try {
        x = JSON.parse(savedNews);
      } catch (e) {
        console.error("Failed to parse saved news file:", e);
        x = [];
      }
    }
    const oldLinks = new Set(x.map((item) => item.link));
    const newNews = newsItems.filter((item) => !oldLinks.has(item.link));
    if (newNews.length > 0) {
      let mails = [];
      if (fs.existsSync(SUBSCRIBERS_FILE)) {
        try {
          mails = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, "utf8"));
        } catch (e) {
          console.error("Failed to parse subscribers file:", e);
        }
      }
      if (mails.length > 0) {
        const mailOptions = {
          from: "gecanewzz@gmail.com",
          to: mails,
          subject: "GECA News Update ",
          text: newNews
            .map((item, i) => `${i + 1}. ${item.title}\n${item.link}`)
            .join("\n\n"),
        };
        try {
          await transporter.sendMail(mailOptions);
        } catch (err) {
          console.error("Failed to send mail:", err);
        }
      }
      x = newsItems;
      fs.writeFileSync(STATE_FILE, JSON.stringify(x, null, 2), "utf8");
    }
  } catch (error) {
    console.error("Error fetching news:", error);
    return [];
  }
}

// --- Scheduler ---
cron.schedule("*/10 * * * * *", checkForNewNews); // Every 10 seconds

// --- Start Server ---
const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
