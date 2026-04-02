#!/usr/bin/env node

/**
 * Deploy Firebase security rules from database.rules.json
 *
 * Usage:
 *   node scripts/deploy-rules.js
 *
 * Prerequisites:
 *   1. npm install firebase-admin
 *   2. Service account key saved as json
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Initialize Firebase Admin
let serviceAccountPath;

if (fs.existsSync(path.join(__dirname, '../serviceAccountKey.json'))) {
  serviceAccountPath = path.join(__dirname, '../serviceAccountKey.json');
} else if (fs.existsSync(path.join(__dirname, '../indie-games-fdf3b-firebase-adminsdk-fbsvc-5925adb236.json'))) {
  serviceAccountPath = path.join(__dirname, '../indie-games-fdf3b-firebase-adminsdk-fbsvc-5925adb236.json');
} else {
  console.error('❌ Error: Service account key not found');
  console.error(' Please save your service account key as:');
  console.error('   - serviceAccountKey.json');
  console.error('   or');
  console.error('   - indie-games-fdf3b-firebase-adminsdk-fbsvc-5925adb236.json');
  console.error(' in the project root directory.');
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://indie-games-fdf3b-default-rtdb.europe-west1.firebasedatabase.app"
});

// Read rules file
const rulesPath = path.join(__dirname, '../database.rules.json');

if (!fs.existsSync(rulesPath)) {
  console.error('❌ Error: database.rules.json not found');
  console.error(' Please ensure database.rules.json exists in the project root.');
  process.exit(1);
}

const rulesContent = fs.readFileSync(rulesPath, 'utf8');

let rules;
try {
  rules = JSON.parse(rulesContent);
} catch (e) {
  console.error('❌ Error: Invalid JSON in database.rules.json');
  console.error(` ${e.message}`);
  process.exit(1);
}

console.log('📄 Rules to be deployed:');
console.log('─'.repeat(50));
console.log(JSON.stringify(rules, null, 2));
console.log('─'.repeat(50));

// Confirm and deploy
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('\nDeploy these security rules to Firebase? (y/N) ', async (answer) => {
  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    console.log('Deployment cancelled.');
    rl.close();
    process.exit(0);
  }

  try {
    console.log('\n🚀 Deploying rules to Firebase...');
    await admin.database().setRules(rulesContent);
    console.log('✅ Security rules deployed successfully!');
    console.log('\nIt may take up to 5 minutes for rules to propagate.');
  } catch (error) {
    console.error('❌ Error deploying rules:');
    console.error(` ${error.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
});
