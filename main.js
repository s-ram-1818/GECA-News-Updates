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

connectDB();

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

// --- Express Routes ---
app.get("/", (req, res) => {
  let news = [];
  (async () => {
    try {
      const news = await News.find().lean();
    } catch (e) {}
  })();

  res.render("index", { news });
});

app.get("/api/news", (req, res) => {
  (async () => {
    try {
      const news = await News.find().lean();
      res.send(news);
    } catch (e) {
      res.status(500).json({ message: "Failed to load news" });
    }
  })();
});
app.get("/api/sends", (req, res) => {
  (async () => {
    try {
      const sends = await Subscriber.find().lean();
      res.send(sends);
    } catch (e) {
      console.error("Invalid news file:", e);
      res.status(500).json({ message: "Failed to load news" });
    }
  })();
});

app.post("/subscribe", (req, res) => {
  const email = req.body.email;

  let emails = [];
  (async () => {
    try {
      emails = await Subscriber.find().lean();
    } catch (e) {
      console.error("Invalid news file:", e);
    }
  })();
  if (!emails.includes(email)) {
    const newSubscriber = new Subscriber({ email });
    newSubscriber
      .save()
      .catch((err) => console.error("Failed to save subscriber:", err));
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
    } else {
      await News.deleteMany({}); // drop everything
      await News.insertMany(newsItems);
    }

    // Get subscriber emails
    const subs = await Subscriber.find({}, "email").lean();
    const emails = subs.map((sub) => sub.email);

    if (!emails.length) {
      return;
    }

    // Compose and send mail
    const mailOptions = {
      from: "gecanewzz@gmail.com",
      to: emails,
      subject: "GECA News Update 📰",
      text: newNews
        .map((item, i) => `${i + 1}. ${item.title}\n${item.link}`)
        .join("\n\n"),
    };

    await transporter.sendMail(mailOptions);
  } catch (error) {}
}

// --- Scheduler ---
cron.schedule("*/10 * * * * *", checkForNewNews); // Every 10 seconds

// --- Start Server ---
const PORT = process.env.PORT;
app.listen(PORT, () => {});
