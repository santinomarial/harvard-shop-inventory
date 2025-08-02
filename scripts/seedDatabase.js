/**
 * Harvard Shop Inventory Management System - Database Seeding Script
 * 
 * This script creates initial users and sample data for development and testing.
 * Run with: npm run seed
 * 
 * @author Your Name
 * @version 1.0.0
 */

const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

// Configuration
const DB_PATH = process.env.DATABASE_URL || './inventory.db';
const SALT_ROUNDS = 12;

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

// Default users to create
const defaultUsers = [
  {
    username: 'admin',
    email: 'admin@harvard.edu',
    password: 'password',
    role: 'admin',
    firstName: 'Admin',
    lastName: 'User'
  },
  {
    username: 'manager',
    email: 'manager@harvard.edu',
    password: 'manager123',
    role: 'manager',
    firstName: 'Store',
    lastName: 'Manager'
  },
  {
    username: 'staff',
    email: 'staff@harvard.edu',
    password: 'staff123',
    role: 'staff',
    firstName: 'Store',
    lastName: 'Staff'
  }
];

// Sample alerts for demonstration
const sampleAlerts = [
  {
    productId: 2, // Harvard Mug
    alertType: 'low_stock',
    message: 'Harvard Mug - Classic White is running low (5 remaining, reorder at 15)',
    priority: 'high'
  },
  {
    productId: 4, // Harvard Notebook Set
    alertType: 'low_stock',
    message: 'Harvard Notebook Set is running low (8 remaining, reorder at 12)',
    priority: 'medium'
  }
];

class DatabaseSeeder {
  constructor() {
    this.db = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          logError(`Failed to connect to database: ${err.message}`);
          reject(err);
        } else {
          logSuccess(`Connected to database: ${DB_PATH}`);
          resolve();
        }
      });
    });
  }

  async checkExistingData() {
    return new Promise((resolve, reject) => {
      this.db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row.count);
        }
      });
    });
  }

  async createUsers() {
    logInfo('Creating default users...');
    
    let createdCount = 0;
    let skippedCount = 0;

    for (const userData of defaultUsers) {
      try {
        // Check if user already exists
        const existingUser = await this.checkUserExists(userData.username, userData.email);
        
        if (existingUser) {
          logWarning(`User ${userData.username} already exists, skipping...`);
          skippedCount++;
          continue;
        }

        // Hash password
        const passwordHash = await bcrypt.hash(userData.password, SALT_ROUNDS);
        
        // Create user
        await this.insertUser({
          ...userData,
          passwordHash
        });

        logSuccess(`Created user: ${userData.username} (${userData.role})`);
        createdCount++;

      } catch (error) {
        logError(`Failed to create user ${userData.username}: ${error.message}`);
      }
    }

    if (createdCount > 0) {
      logSuccess(`Created ${createdCount} new users`);
    }
    
    if (skippedCount > 0) {
      logInfo(`Skipped ${skippedCount} existing users`);
    }

    // Display login credentials
    this.displayLoginCredentials();
  }

  async checkUserExists(username, email) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT id FROM users WHERE username = ? OR email = ?",
        [username, email],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!!row);
          }
        }
      );
    });
  }

  async insertUser(userData) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO users (username, email, password_hash, role, first_name, last_name) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          userData.username,
          userData.email,
          userData.passwordHash,
          userData.role,
          userData.firstName,
          userData.lastName
        ],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.lastID);
          }
        }
      );
    });
  }

  async createSampleAlerts() {
    logInfo('Creating sample alerts...');
    
    let createdCount = 0;

    for (const alertData of sampleAlerts) {
      try {
        // Check if alert already exists
        const existingAlert = await this.checkAlertExists(alertData.productId, alertData.alertType);
        
        if (existingAlert) {
          logWarning(`Alert for product ${alertData.productId} already exists, skipping...`);
          continue;
        }

        await this.insertAlert(alertData);
        logSuccess(`Created alert for product ${alertData.productId}`);
        createdCount++;

      } catch (error) {
        logError(`Failed to create alert: ${error.message}`);
      }
    }

    if (createdCount > 0) {
      logSuccess(`Created ${createdCount} sample alerts`);
    }
  }

  async checkAlertExists(productId, alertType) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT id FROM alerts WHERE product_id = ? AND alert_type = ? AND status = 'active'",
        [productId, alertType],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!!row);
          }
        }
      );
    });
  }

  async insertAlert(alertData) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO alerts (product_id, alert_type, message, priority) 
         VALUES (?, ?, ?, ?)`,
        [
          alertData.productId,
          alertData.alertType,
          alertData.message,
          alertData.priority
        ],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.lastID);
          }
        }
      );
    });
  }

  async createSampleStockMovements() {
    logInfo('Creating sample stock movements...');
    
    // Get admin user ID for stock movements
    const adminUser = await this.getUserByUsername('admin');
    if (!adminUser) {
      logWarning('Admin user not found, skipping stock movements creation');
      return;
    }

    const sampleMovements = [
      { productId: 1, type: 'restock', change: 50, reason: 'Initial inventory setup' },
      { productId: 2, type: 'restock', change: 30, reason: 'Weekly restock' },
      { productId: 3, type: 'restock', change: 75, reason: 'Back to school preparation' },
      { productId: 1, type: 'sale', change: -25, reason: 'Sales transactions' },
      { productId: 2, type: 'sale', change: -25, reason: 'Sales transactions' },
      { productId: 3, type: 'sale', change: -30, reason: 'Sales transactions' }
    ];

    let createdCount = 0;

    for (const movement of sampleMovements) {
      try {
        // Get current quantity
        const currentInventory = await this.getCurrentInventory(movement.productId);
        if (!currentInventory) continue;

        const previousQuantity = currentInventory.quantity;
        const newQuantity = Math.max(0, previousQuantity + movement.change);

        await this.insertStockMovement({
          productId: movement.productId,
          movementType: movement.type,
          quantityChange: movement.change,
          previousQuantity: previousQuantity,
          newQuantity: newQuantity,
          reason: movement.reason,
          userId: adminUser.id
        });

        // Update inventory quantity
        await this.updateInventoryQuantity(movement.productId, newQuantity);

        createdCount++;

      } catch (error) {
        logError(`Failed to create stock movement: ${error.message}`);
      }
    }

    if (createdCount > 0) {
      logSuccess(`Created ${createdCount} sample stock movements`);
    }
  }

  async getUserByUsername(username) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM users WHERE username = ?",
        [username],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  async getCurrentInventory(productId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM inventory WHERE product_id = ?",
        [productId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  async insertStockMovement(movementData) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO stock_movements (product_id, movement_type, quantity_change, previous_quantity, new_quantity, reason, user_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          movementData.productId,
          movementData.movementType,
          movementData.quantityChange,
          movementData.previousQuantity,
          movementData.newQuantity,
          movementData.reason,
          movementData.userId
        ],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.lastID);
          }
        }
      );
    });
  }

  async updateInventoryQuantity(productId, newQuantity) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?",
        [newQuantity, productId],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  displayLoginCredentials() {
    log('\n' + '='.repeat(60), 'cyan');
    log('🔐 LOGIN CREDENTIALS', 'cyan');
    log('='.repeat(60), 'cyan');
    
    defaultUsers.forEach(user => {
      log(`👤 ${user.role.toUpperCase()}:`, 'bright');
      log(`   Username: ${user.username}`, 'green');
      log(`   Password: ${user.password}`, 'green');
      log(`   Email: ${user.email}`, 'blue');
      log('');
    });
    
    log('='.repeat(60), 'cyan');
    log('🌐 ACCESS INFORMATION', 'cyan');
    log('='.repeat(60), 'cyan');
    log('Frontend: http://localhost:3000', 'green');
    log('Backend API: http://localhost:5000/api', 'green');
    log('Health Check: http://localhost:5000/api/health', 'blue');
    log('='.repeat(60), 'cyan');
  }

  async getSystemStats() {
    return new Promise((resolve, reject) => {
      const queries = {
        users: "SELECT COUNT(*) as count FROM users",
        products: "SELECT COUNT(*) as count FROM products",
        sales: "SELECT COUNT(*) as count FROM sales",
        alerts: "SELECT COUNT(*) as count FROM alerts WHERE status = 'active'"
      };

      const results = {};
      let completed = 0;

      Object.entries(queries).forEach(([key, sql]) => {
        this.db.get(sql, (err, row) => {
          if (!err) results[key] = row.count;
          completed++;
          if (completed === Object.keys(queries).length) {
            resolve(results);
          }
        });
      });
    });
  }

  async displayStats() {
    try {
      const stats = await this.getSystemStats();
      
      log('\n' + '='.repeat(40), 'magenta');
      log('📊 SYSTEM STATISTICS', 'magenta');
      log('='.repeat(40), 'magenta');
      log(`Users: ${stats.users || 0}`, 'green');
      log(`Products: ${stats.products || 0}`, 'green');
      log(`Sales Records: ${stats.sales || 0}`, 'green');
      log(`Active Alerts: ${stats.alerts || 0}`, 'green');
      log('='.repeat(40), 'magenta');
    } catch (error) {
      logWarning('Could not fetch system statistics');
    }
  }

  async close() {
    return new Promise((resolve) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            logError(`Error closing database: ${err.message}`);
          } else {
            logSuccess('Database connection closed');
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

// Main seeding function
async function seedDatabase() {
  const seeder = new DatabaseSeeder();
  
  try {
    log('\n🌱 Harvard Shop Inventory Database Seeding', 'bright');
    log('=' * 50, 'cyan');
    
    // Initialize database connection
    await seeder.initialize();
    
    // Check if database already has data
    const existingUserCount = await seeder.checkExistingData();
    
    if (existingUserCount > 0) {
      logInfo(`Found ${existingUserCount} existing users in database`);
      logInfo('Proceeding with selective seeding...');
    } else {
      logInfo('Empty database detected, performing full seeding...');
    }
    
    // Create users
    await seeder.createUsers();
    
    // Create sample alerts (only if we have products)
    await seeder.createSampleAlerts();
    
    // Create sample stock movements
    await seeder.createSampleStockMovements();
    
    // Display system statistics
    await seeder.displayStats();
    
    logSuccess('\n🎉 Database seeding completed successfully!');
    logInfo('You can now start the application:');
    logInfo('  Backend: npm run dev');
    logInfo('  Frontend: npm run client');
    
  } catch (error) {
    logError(`Seeding failed: ${error.message}`);
    process.exit(1);
  } finally {
    await seeder.close();
    process.exit(0);
  }
}

// Handle script execution
if (require.main === module) {
  // Script is being run directly
  seedDatabase();
} else {
  // Script is being imported
  module.exports = { DatabaseSeeder, seedDatabase };
}