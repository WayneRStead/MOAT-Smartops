// core-backend/utils/passwords.js
const bcrypt = require('bcrypt');
const ROUNDS = 10;

exports.hash = (plain) => bcrypt.hash(plain, ROUNDS);
exports.verify = (plain, hash) => bcrypt.compare(plain, hash || '');
