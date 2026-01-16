const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
const usersFile = path.join(dataDir, "users.json");

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function loadStore() {
  ensureDataDir();
  if (!fs.existsSync(usersFile)) {
    return { users: {} };
  }
  try {
    const raw = fs.readFileSync(usersFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { users: {} };
    }
    if (!parsed.users || typeof parsed.users !== "object") {
      parsed.users = {};
    }
    return parsed;
  } catch (error) {
    return { users: {} };
  }
}

function saveStore(store) {
  ensureDataDir();
  const tmpPath = `${usersFile}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, usersFile);
}

const store = loadStore();

function getUser(userId) {
  return store.users[userId] || null;
}

function upsertUser(userId, updates) {
  const existing = store.users[userId] || {};
  store.users[userId] = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  saveStore(store);
  return store.users[userId];
}

function deleteUser(userId) {
  if (store.users[userId]) {
    delete store.users[userId];
    saveStore(store);
  }
}

function allUsers() {
  return store.users;
}

module.exports = {
  getUser,
  upsertUser,
  deleteUser,
  allUsers
};
