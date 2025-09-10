// scripts/hash-password.js
const bcrypt = require('bcryptjs');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node scripts/hash-password.js <password>');
    process.exit(1);
  }

  const plain = args[0];
  const rounds = 10; // cost factor, 10 is safe and fast enough for most use

  try {
    const hash = await bcrypt.hash(plain, rounds);
    console.log(`Plain: ${plain}`);
    console.log(`Hash : ${hash}`);
  } catch (err) {
    console.error('Error hashing password:', err);
    process.exit(1);
  }
}

main();
