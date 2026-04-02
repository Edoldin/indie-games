#!/usr/bin/env node

/**
 * Upload game configurations to Firebase Realtime Database
 *
 * Usage:
 *   node scripts/upload-game-configs.js
 *
 * Prerequisites:
 *   1. npm install firebase-admin
 *   2. Generate service account key from Firebase Console
 *      (Project Settings → Service accounts → Generate new private key)
 *   3. Save service account key as "serviceAccountKey.json" in project root
 *   4. Ensure game-configs.json exists in project root
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Initialize Firebase Admin
const serviceAccountPath = path.join(__dirname, '../indie-games-fdf3b-firebase-adminsdk-fbsvc-5925adb236.json');

if (!fs.existsSync(serviceAccountPath)) {
  console.error('❌ Error: serviceAccountKey.json not found');
  console.error('   Please generate a service account key from Firebase Console');
  console.error('   (Project Settings → Service accounts → Generate new private key)');  console.error('   and save it as "serviceAccountKey.json" in the project root.');
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://indie-games-fdf3b-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

// Read game configs
const gameConfigsPath = path.join(__dirname, '../game-configs.json');

if (!fs.existsSync(gameConfigsPath)) {
  console.error('❌ Error: game-configs.json not found');
  console.error('   Please ensure game-configs.json exists in the project root.');
  process.exit(1);
}

const gameConfigs = JSON.parse(fs.readFileSync(gameConfigsPath, 'utf8'));

// Validate configs
const requiredFields = ['name', 'status', 'icon', 'description', 'players'];
const invalidGames = [];

Object.entries(gameConfigs).forEach(([slug, config]) => {
  if (config.slug !== slug) {
    console.warn(`⚠️  Warning: slug mismatch in ${slug} (config.slug is "${config.slug}")`);
  }

  const missingFields = requiredFields.filter(field => !config[field]);
  if (missingFields.length > 0) {
    invalidGames.push({ slug, missingFields });
  }

  if (config.status === 'live' && (!config.gameUrl || !config.settingsHtml)) {
    console.warn(`⚠️  Warning: ${slug} is marked 'live' but missing gameUrl or settingsHtml`);
  }
});

if (invalidGames.length > 0) {
  console.error('❌ Error: Invalid game configs found:');
  invalidGames.forEach(({ slug, missingFields }) => {
    console.error(`   - ${slug}: missing ${missingFields.join(', ')}`);
  });
  process.exit(1);
}

console.log(`✓ Found ${Object.keys(gameConfigs).length} games:`);
Object.keys(gameConfigs).forEach(slug => {
  const game = gameConfigs[slug];
  const status = game.status === 'live' ? '🟢' : '🟡';
  console.log(`  ${status} ${slug}: ${game.name}`);
});

// Confirm upload
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('\nUpload these game configurations to Firebase? (y/N) ', async (answer) => {
  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    console.log('Upload cancelled.');
    rl.close();
    process.exit(0);
  }

  try {
    console.log('\n📤 Uploading to Firebase...');
    await db.ref('gameConfigs').set(gameConfigs);
    console.log('✅ Successfully uploaded game configs to Firebase!');
  } catch (error) {
    console.error('❌ Error uploading to Firebase:');
    console.error(error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
});
