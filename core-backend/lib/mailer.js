// core-backend/lib/mailer.js
const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST || 'localhost';
const port = Number(process.env.SMTP_PORT || 587);

// Interpret SMTP_SECURE flexibly: true/1/yes/ssl => true
const secureEnv = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
let secure = false;
if (
  secureEnv === 'true' ||
  secureEnv === '1' ||
  secureEnv === 'yes' ||
  secureEnv === 'ssl' ||
  port === 465 // implicit TLS typical
) {
  secure = true;
}

const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';
const from =
  process.env.SMTP_FROM || `MOAT SmartOps <${user || 'no-reply@example.com'}>`;

const transporter = nodemailer.createTransport({
  host,
  port,
  secure, // true for 465 / implicit TLS, false for 587 + STARTTLS
  auth: user && pass ? { user, pass } : undefined,
});

// Optional: verify on startup (you'll see errors in server logs)
transporter.verify((err, success) => {
  if (err) {
    console.warn('[mailer] SMTP verify failed:', err.message);
  } else {
    console.log('[mailer] SMTP server is ready to take our messages');
  }
});

async function sendPasswordResetEmail({ to, resetUrl, orgName }) {
  const orgLabel = orgName || 'MOAT SmartOps';
  const subject = `${orgLabel} – Password Reset`;
  const text = [
    `You requested a password reset for your ${orgLabel} account.`,
    '',
    `Click the link below to choose a new password:`,
    resetUrl,
    '',
    `If you did not request this, you can safely ignore this email.`,
  ].join('\n');

  const html = `
    <p>You requested a password reset for your <strong>${orgLabel}</strong> account.</p>
    <p>
      Click the link below to choose a new password:
      <br />
      <a href="${resetUrl}">${resetUrl}</a>
    </p>
    <p>If you did not request this, you can safely ignore this email.</p>
  `;

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });

  console.log('[mailer] Password reset email sent:', info.messageId);
}

module.exports = {
  sendPasswordResetEmail,
};
