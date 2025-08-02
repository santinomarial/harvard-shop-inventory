/**
 * Harvard Shop Inventory Management System - Backend API Server
 * 
 * A comprehensive inventory management solution built with Express.js, SQLite, and JWT authentication.
 * Features real-time inventory tracking, automated alerts, and sales analytics.
 * 
 * @author Your Name
 * @version 1.0.0
 */

require('dotenv').config();
const multer = require('multer');
const fs = require('fs');
const csvParser = require('csv-parser');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'harvard-shop-secure-secret-key-2024';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Security and performance middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for development with Tailwind CDN
}));
app.use(compression());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

// CORS configuration
const corsOptions = {
  origin: NODE_ENV === 'production' 
    ? ['https://your-app-name.herokuapp.com', 'https://your-domain.com']
    : ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
  optionsSuccessStatus: 200
};
// Ensure uploads directory exists
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  // Allow images and CSV files
  if (file.mimetype.startsWith('image/') || file.mimetype === 'text/csv') {
    cb(null, true);
  } else {
    cb(new Error('Only images and CSV files are allowed!'), false);
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Serve uploaded files statically
app.use('/uploads', express.static('uploads'));

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files in production
if (NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/build')));
}

// Database configuration
const DB_PATH = process.env.DATABASE_URL || './inventory.db';
let db;

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('❌ Error opening database:', err.message);
        reject(err);
      } else {
        console.log('✅ Connected to SQLite database');
        createTables()
          .then(() => insertSampleData())
          .then(resolve)
          .catch(reject);
      }
    });
  });
}

function createTables() {
  return new Promise((resolve, reject) => {
    const tables = [
      // Products table - core product information
      `CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        supplier TEXT,
        cost_price DECIMAL(10,2),
        sell_price DECIMAL(10,2) NOT NULL,
        description TEXT,
        sku TEXT UNIQUE,
        image_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Inventory table - stock levels and reorder information
      `CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        reorder_level INTEGER NOT NULL DEFAULT 10,
        max_stock_level INTEGER DEFAULT 100,
        last_restocked DATETIME,
        location TEXT DEFAULT 'Main Store',
        shelf_location TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
      )`,
      
      // Sales table - transaction records
      `CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        quantity_sold INTEGER NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        total_amount DECIMAL(10,2) NOT NULL,
        sale_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        cashier_name TEXT,
        payment_method TEXT DEFAULT 'cash',
        transaction_id TEXT,
        FOREIGN KEY (product_id) REFERENCES products (id)
      )`,
      
      // Alerts table - low stock and other notifications
      `CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        alert_type TEXT NOT NULL CHECK (alert_type IN ('low_stock', 'out_of_stock', 'overstock', 'price_change')),
        message TEXT NOT NULL,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'dismissed')),
        priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        resolved_by TEXT,
        FOREIGN KEY (product_id) REFERENCES products (id)
      )`,
      
      // Users table - authentication and authorization
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'staff' CHECK (role IN ('admin', 'manager', 'staff')),
        first_name TEXT,
        last_name TEXT,
        phone TEXT,
        is_active BOOLEAN DEFAULT 1,
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Stock movements table - audit trail for inventory changes
      `CREATE TABLE IF NOT EXISTS stock_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        movement_type TEXT NOT NULL CHECK (movement_type IN ('sale', 'restock', 'adjustment', 'return', 'damage')),
        quantity_change INTEGER NOT NULL,
        previous_quantity INTEGER NOT NULL,
        new_quantity INTEGER NOT NULL,
        reason TEXT,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products (id),
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`
    ];

    let completed = 0;
    const errors = [];

    tables.forEach((sql, index) => {
      db.run(sql, (err) => {
        if (err) {
          console.error(`❌ Error creating table ${index + 1}:`, err.message);
          errors.push(err);
        } else {
          console.log(`✅ Table ${index + 1} created successfully`);
        }
        
        completed++;
        if (completed === tables.length) {
          if (errors.length > 0) {
            reject(new Error(`Failed to create ${errors.length} tables`));
          } else {
            console.log('✅ All database tables created successfully');
            resolve();
          }
        }
      });
    });
  });
}

function insertSampleData() {
  return new Promise((resolve) => {
    // Check if data already exists
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
      if (err || row.count > 0) {
        console.log('📊 Sample data already exists, skipping insertion');
        resolve();
        return;
      }

      console.log('📦 Inserting Harvard Shop sample data...');

      // Harvard Shop product catalog
      const sampleProducts = [
        ['Harvard Hoodie - Crimson', 'Apparel', 'College Bookstore Supply', 35.00, 65.00, 'Classic Harvard crimson hoodie with embroidered university logo. 80% cotton, 20% polyester blend.', 'HRV-HOO-001'],
        ['Harvard Mug - Classic White', 'Accessories', 'Campus Store Inc', 6.50, 12.95, 'Premium white ceramic mug featuring the official Harvard seal. Dishwasher and microwave safe.', 'HRV-MUG-001'],
        ['Harvard T-Shirt - Navy Blue', 'Apparel', 'College Bookstore Supply', 12.00, 24.99, 'Comfortable navy blue t-shirt with Harvard logo. 100% pre-shrunk cotton.', 'HRV-TSH-001'],
        ['Harvard Notebook Set', 'Stationery', 'Academic Supplies Co', 9.25, 18.50, 'Set of 3 spiral-bound notebooks with Harvard branding. College-ruled, 80 sheets each.', 'HRV-NOT-001'],
        ['Harvard Shield Keychain', 'Accessories', 'Campus Store Inc', 4.50, 8.99, 'Durable metal keychain featuring the Harvard shield in antique brass finish.', 'HRV-KEY-001'],
        ['Harvard Sweatpants - Gray', 'Apparel', 'College Bookstore Supply', 25.00, 45.00, 'Comfortable Harvard sweatpants in heather gray. Perfect for campus life.', 'HRV-SWP-001'],
        ['Harvard Water Bottle - Stainless', 'Accessories', 'Campus Store Inc', 8.00, 16.99, '20oz stainless steel water bottle with Harvard logo. Keeps drinks cold for 24 hours.', 'HRV-WTR-001'],
        ['Harvard Pennant - Traditional', 'Accessories', 'Academic Supplies Co', 3.00, 7.99, 'Traditional felt pennant flag in Harvard crimson with gold lettering.', 'HRV-PEN-001'],
        ['Harvard Baseball Cap', 'Apparel', 'College Bookstore Supply', 15.00, 28.99, 'Adjustable baseball cap in Harvard crimson with embroidered H logo.', 'HRV-CAP-001'],
        ['Harvard Laptop Sticker Pack', 'Stationery', 'Academic Supplies Co', 2.50, 5.99, 'Pack of 5 vinyl stickers featuring Harvard logos and quotes. Weather-resistant.', 'HRV-STK-001']
      ];

      // Corresponding inventory levels (realistic for a college shop)
      const sampleInventory = [
        [1, 25, 10, '2024-07-15', 'Main Store', 'A-1'],
        [2, 5, 15, '2024-07-20', 'Main Store', 'B-3'],
        [3, 45, 20, '2024-07-18', 'Main Store', 'A-2'],
        [4, 8, 12, '2024-07-22', 'Main Store', 'C-1'],
        [5, 78, 25, '2024-07-10', 'Main Store', 'B-1'],
        [6, 15, 8, '2024-07-25', 'Main Store', 'A-3'],
        [7, 32, 15, '2024-07-12', 'Main Store', 'B-2'],
        [8, 12, 10, '2024-07-28', 'Main Store', 'C-2'],
        [9, 22, 12, '2024-07-20', 'Main Store', 'A-4'],
        [10, 150, 50, '2024-07-25', 'Main Store', 'C-3']
      ];

      // Recent sales data for analytics
      const sampleSales = [
        [1, 3, 65.00, 195.00, '2024-07-30 14:30:00', 'John D.', 'card'],
        [2, 2, 12.95, 25.90, '2024-07-30 15:15:00', 'Sarah M.', 'cash'],
        [3, 5, 24.99, 124.95, '2024-07-29 11:20:00', 'Mike R.', 'card'],
        [4, 1, 18.50, 18.50, '2024-07-29 16:45:00', 'Lisa K.', 'cash'],
        [5, 4, 8.99, 35.96, '2024-07-28 12:10:00', 'Tom B.', 'card'],
        [6, 2, 45.00, 90.00, '2024-07-28 13:30:00', 'Emma W.', 'card'],
        [7, 1, 16.99, 16.99, '2024-07-27 10:15:00', 'Alex P.', 'cash'],
        [9, 3, 28.99, 86.97, '2024-07-27 14:20:00', 'Chris L.', 'card'],
        [10, 8, 5.99, 47.92, '2024-07-26 11:30:00', 'Jordan M.', 'cash']
      ];

      // Insert products
      const productStmt = db.prepare(`
        INSERT INTO products (name, category, supplier, cost_price, sell_price, description, sku) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      sampleProducts.forEach(product => {
        productStmt.run(product);
      });
      productStmt.finalize();

      // Insert inventory
      const inventoryStmt = db.prepare(`
        INSERT INTO inventory (product_id, quantity, reorder_level, last_restocked, location, shelf_location) 
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      sampleInventory.forEach(inv => {
        inventoryStmt.run(inv);
      });
      inventoryStmt.finalize();

      // Insert sales
      const salesStmt = db.prepare(`
        INSERT INTO sales (product_id, quantity_sold, unit_price, total_amount, sale_date, cashier_name, payment_method) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      sampleSales.forEach(sale => {
        salesStmt.run(sale);
      });
      salesStmt.finalize();

      console.log('✅ Sample data inserted successfully');
      resolve();
    });
  });
}

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Role-based authorization middleware
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

// API Routes

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    version: '1.0.0'
  });
});

// Authentication Routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, role = 'staff', firstName, lastName } = req.body;

    // Input validation
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    
    db.run(
      `INSERT INTO users (username, email, password_hash, role, first_name, last_name) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [username, email, hashedPassword, role, firstName, lastName],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username or email already exists' });
          }
          return res.status(500).json({ error: 'Failed to create user' });
        }
        
        console.log(`✅ New user registered: ${username} (${role})`);
        res.status(201).json({ 
          message: 'User created successfully', 
          userId: this.lastID 
        });
      }
    );
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    db.get(
      "SELECT * FROM users WHERE username = ? AND is_active = 1", 
      [username], 
      async (err, user) => {
        if (err) {
          console.error('Login database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (!user) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }

        try {
          const validPassword = await bcrypt.compare(password, user.password_hash);
          if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
          }

          // Update last login
          db.run(
            "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?",
            [user.id]
          );

          const token = jwt.sign(
            { 
              userId: user.id, 
              username: user.username, 
              role: user.role,
              email: user.email
            },
            JWT_SECRET,
            { expiresIn: '24h' }
          );

          console.log(`✅ User logged in: ${username}`);
          res.json({ 
            token, 
            user: { 
              id: user.id, 
              username: user.username, 
              email: user.email,
              role: user.role,
              firstName: user.first_name,
              lastName: user.last_name
            } 
          });
        } catch (bcryptError) {
          console.error('Password comparison error:', bcryptError);
          res.status(500).json({ error: 'Authentication failed' });
        }
      }
    );
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Products Routes
app.get('/api/products', (req, res) => {
  const { category, search, sortBy = 'name', order = 'ASC' } = req.query;
  
  let sql = `
    SELECT 
      p.*,
      i.quantity,
      i.reorder_level,
      i.max_stock_level,
      i.last_restocked,
      i.location,
      i.shelf_location,
      CASE 
        WHEN i.quantity <= 0 THEN 'out_of_stock'
        WHEN i.quantity <= i.reorder_level THEN 'low_stock'
        WHEN i.quantity >= i.max_stock_level THEN 'overstock'
        ELSE 'in_stock'
      END as stock_status
    FROM products p
    LEFT JOIN inventory i ON p.id = i.product_id
    WHERE 1=1
  `;
  
  const params = [];
  
  if (category && category !== 'all') {
    sql += ' AND p.category = ?';
    params.push(category);
  }
  
  if (search) {
    sql += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.sku LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }
  
  sql += ` ORDER BY ${sortBy} ${order}`;
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Products fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch products' });
    }
    res.json(rows);
  });
});

app.get('/api/products/:id', (req, res) => {
  const sql = `
    SELECT 
      p.*,
      i.quantity,
      i.reorder_level,
      i.max_stock_level,
      i.last_restocked,
      i.location,
      i.shelf_location
    FROM products p
    LEFT JOIN inventory i ON p.id = i.product_id
    WHERE p.id = ?
  `;
  
  db.get(sql, [req.params.id], (err, row) => {
    if (err) {
      console.error('Product fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch product' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(row);
  });
});

app.post('/api/products', authenticateToken, requireRole(['admin', 'manager']), (req, res) => {
  const { 
    name, category, supplier, cost_price, sell_price, description, sku, 
    quantity = 0, reorder_level = 10, max_stock_level = 100, location = 'Main Store' 
  } = req.body;
  
  if (!name || !category || !sell_price) {
    return res.status(400).json({ error: 'Name, category, and sell price are required' });
  }
  
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    db.run(
      `INSERT INTO products (name, category, supplier, cost_price, sell_price, description, sku) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, category, supplier, cost_price, sell_price, description, sku],
      function(err) {
        if (err) {
          db.run('ROLLBACK');
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'SKU already exists' });
          }
          return res.status(500).json({ error: 'Failed to create product' });
        }
        
        const productId = this.lastID;
        
        db.run(
          `INSERT INTO inventory (product_id, quantity, reorder_level, max_stock_level, location) 
           VALUES (?, ?, ?, ?, ?)`,
          [productId, quantity, reorder_level, max_stock_level, location],
          function(err) {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to create inventory record' });
            }
            
            // Log stock movement
            if (quantity > 0) {
              db.run(
                `INSERT INTO stock_movements (product_id, movement_type, quantity_change, previous_quantity, new_quantity, reason, user_id) 
                 VALUES (?, 'restock', ?, 0, ?, 'Initial stock', ?)`,
                [productId, quantity, quantity, req.user.userId]
              );
            }
            
            db.run('COMMIT');
            console.log(`✅ New product created: ${name} (ID: ${productId})`);
            res.status(201).json({ 
              id: productId, 
              message: 'Product created successfully' 
            });
          }
        );
      }
    );
  });
});

app.put('/api/products/:id', authenticateToken, requireRole(['admin', 'manager']), (req, res) => {
  const { 
    name, category, supplier, cost_price, sell_price, description, sku, 
    quantity, reorder_level, max_stock_level, location 
  } = req.body;
  
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    db.run(
      `UPDATE products SET 
       name = ?, category = ?, supplier = ?, cost_price = ?, sell_price = ?, 
       description = ?, sku = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [name, category, supplier, cost_price, sell_price, description, sku, req.params.id],
      function(err) {
        if (err) {
          db.run('ROLLBACK');
          return res.status(400).json({ error: 'Failed to update product' });
        }
        
        if (this.changes === 0) {
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Product not found' });
        }
        
        // Get current quantity for stock movement logging
        db.get(
          "SELECT quantity FROM inventory WHERE product_id = ?",
          [req.params.id],
          (err, row) => {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to fetch current inventory' });
            }
            
            const previousQuantity = row ? row.quantity : 0;
            
            db.run(
              `UPDATE inventory SET 
               quantity = ?, reorder_level = ?, max_stock_level = ?, location = ?, 
               updated_at = CURRENT_TIMESTAMP 
               WHERE product_id = ?`,
              [quantity, reorder_level, max_stock_level, location, req.params.id],
              function(err) {
                if (err) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to update inventory' });
                }
                
                // Log stock movement if quantity changed
                if (quantity !== previousQuantity) {
                  const quantityChange = quantity - previousQuantity;
                  const movementType = quantityChange > 0 ? 'adjustment' : 'adjustment';
                  
                  db.run(
                    `INSERT INTO stock_movements (product_id, movement_type, quantity_change, previous_quantity, new_quantity, reason, user_id) 
                     VALUES (?, ?, ?, ?, ?, 'Manual adjustment', ?)`,
                    [req.params.id, movementType, quantityChange, previousQuantity, quantity, req.user.userId]
                  );
                }
                
                db.run('COMMIT');
                console.log(`✅ Product updated: ID ${req.params.id}`);
                res.json({ message: 'Product updated successfully' });
              }
            );
          }
        );
      }
    );
  });
});

app.delete('/api/products/:id', authenticateToken, requireRole(['admin']), (req, res) => {
  db.run("DELETE FROM products WHERE id = ?", [req.params.id], function(err) {
    if (err) {
      console.error('Product deletion error:', err);
      return res.status(500).json({ error: 'Failed to delete product' });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    console.log(`✅ Product deleted: ID ${req.params.id}`);
    res.json({ message: 'Product deleted successfully' });
  });
});

// Upload product image
app.post('/api/products/:id/image', authenticateToken, upload.single('image'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
  
    const productId = req.params.id;
    const imageUrl = `/uploads/${req.file.filename}`;
    
    db.run(
      "UPDATE products SET image_url = ? WHERE id = ?",
      [imageUrl, productId],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Product not found' });
        }
        
        console.log(`✅ Image uploaded for product ${productId}: ${imageUrl}`);
        res.json({ 
          message: 'Image uploaded successfully', 
          imageUrl: imageUrl 
        });
      }
    );
  });
  
  // Bulk import products from CSV
  app.post('/api/products/import', authenticateToken, upload.single('csvFile'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }
  
    const results = [];
    
    fs.createReadStream(req.file.path)
      .pipe(csvParser())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        // Process CSV data and insert into database
        let insertedCount = 0;
        const errors = [];
        
        results.forEach((row, index) => {
          const { name, category, supplier, cost_price, sell_price, description, sku, quantity, reorder_level } = row;
          
          if (!name || !category || !sell_price) {
            errors.push(`Row ${index + 1}: Missing required fields`);
            return;
          }
          
          db.run(
            "INSERT INTO products (name, category, supplier, cost_price, sell_price, description, sku) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [name, category, supplier, parseFloat(cost_price) || 0, parseFloat(sell_price), description, sku],
            function(err) {
              if (err) {
                errors.push(`Row ${index + 1}: ${err.message}`);
              } else {
                const productId = this.lastID;
                
                // Add inventory record
                db.run(
                  "INSERT INTO inventory (product_id, quantity, reorder_level) VALUES (?, ?, ?)",
                  [productId, parseInt(quantity) || 0, parseInt(reorder_level) || 10]
                );
                
                insertedCount++;
              }
            }
          );
        });
        
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        
        res.json({
          message: 'CSV import completed',
          totalRows: results.length,
          insertedCount: insertedCount,
          errors: errors
        });
      });
  });
  
  // Export products to CSV
  app.get('/api/products/export', authenticateToken, (req, res) => {
    const sql = `
      SELECT 
        p.name, p.category, p.supplier, p.cost_price, p.sell_price, 
        p.description, p.sku, i.quantity, i.reorder_level
      FROM products p
      LEFT JOIN inventory i ON p.id = i.product_id
      ORDER BY p.name
    `;
    
    db.all(sql, (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      // Convert to CSV format
      const csvHeader = 'Name,Category,Supplier,Cost Price,Sell Price,Description,SKU,Quantity,Reorder Level\n';
      const csvRows = rows.map(row => {
        return [
          `"${row.name || ''}"`,
          `"${row.category || ''}"`,
          `"${row.supplier || ''}"`,
          row.cost_price || 0,
          row.sell_price || 0,
          `"${row.description || ''}"`,
          `"${row.sku || ''}"`,
          row.quantity || 0,
          row.reorder_level || 0
        ].join(',');
      }).join('\n');
      
      const csvContent = csvHeader + csvRows;
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="harvard-shop-inventory.csv"');
      res.send(csvContent);
    });
  });
// Sales Routes
app.get('/api/sales', authenticateToken, (req, res) => {
  const { startDate, endDate, limit = 100 } = req.query;
  
  let sql = `
    SELECT 
      s.*,
      p.name as product_name,
      p.category,
      p.sku
    FROM sales s
    JOIN products p ON s.product_id = p.id
    WHERE 1=1
  `;
  
  const params = [];
  
  if (startDate) {
    sql += ' AND DATE(s.sale_date) >= ?';
    params.push(startDate);
  }
  
  if (endDate) {
    sql += ' AND DATE(s.sale_date) <= ?';
    params.push(endDate);
  }
  
  sql += ' ORDER BY s.sale_date DESC LIMIT ?';
  params.push(parseInt(limit));
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Sales fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch sales' });
    }
    res.json(rows);
  });
});

app.post('/api/sales', authenticateToken, (req, res) => {
  const { product_id, quantity_sold, unit_price, cashier_name, payment_method = 'cash' } = req.body;
  
  if (!product_id || !quantity_sold || !unit_price || quantity_sold <= 0) {
    return res.status(400).json({ error: 'Valid product ID, quantity, and unit price are required' });
  }
  
  const total_amount = parseFloat((quantity_sold * unit_price).toFixed(2));
  
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    // Check inventory availability
    db.get(
      "SELECT quantity, reorder_level FROM inventory WHERE product_id = ?",
      [product_id],
      (err, row) => {
        if (err || !row) {
          db.run('ROLLBACK');
          return res.status(400).json({ error: 'Product not found in inventory' });
        }
        
        if (row.quantity < quantity_sold) {
          db.run('ROLLBACK');
          return res.status(400).json({ 
            error: 'Insufficient inventory',
            available: row.quantity,
            requested: quantity_sold
          });
        }
        
        const previousQuantity = row.quantity;
        const newQuantity = previousQuantity - quantity_sold;
        
        // Record the sale
        db.run(
          `INSERT INTO sales (product_id, quantity_sold, unit_price, total_amount, cashier_name, payment_method) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [product_id, quantity_sold, unit_price, total_amount, cashier_name, payment_method],
          function(err) {
            if (err) {
              db.run('ROLLBACK');
              console.error('Sale recording error:', err);
              return res.status(500).json({ error: 'Failed to record sale' });
            }
            
            const saleId = this.lastID;
            
            // Update inventory
            db.run(
              "UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?",
              [newQuantity, product_id],
              (err) => {
                if (err) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to update inventory' });
                }
                
                // Log stock movement
                db.run(
                  `INSERT INTO stock_movements (product_id, movement_type, quantity_change, previous_quantity, new_quantity, reason, user_id) 
                   VALUES (?, 'sale', ?, ?, ?, ?, ?)`,
                  [product_id, -quantity_sold, previousQuantity, newQuantity, `Sale #${saleId}`, req.user.userId],
                  (err) => {
                    if (err) {
                      console.error('Stock movement logging error:', err);
                    }
                    
                    db.run('COMMIT');
                    
                    // Check for low stock alert
                    if (newQuantity <= row.reorder_level) {
                      createLowStockAlert(product_id, newQuantity, row.reorder_level);
                    }
                    
                    console.log(`✅ Sale recorded: Product ${product_id}, Quantity ${quantity_sold}, Total ${total_amount}`);
                    res.status(201).json({ 
                      id: saleId, 
                      message: 'Sale recorded successfully',
                      newQuantity: newQuantity,
                      lowStockAlert: newQuantity <= row.reorder_level
                    });
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

// Analytics Routes
app.get('/api/analytics/dashboard', (req, res) => {
  const queries = {
    totalProducts: "SELECT COUNT(*) as count FROM products",
    totalValue: `
      SELECT COALESCE(SUM(i.quantity * p.sell_price), 0) as total 
      FROM inventory i 
      JOIN products p ON i.product_id = p.id
    `,
    lowStockCount: "SELECT COUNT(*) as count FROM inventory WHERE quantity <= reorder_level",
    outOfStockCount: "SELECT COUNT(*) as count FROM inventory WHERE quantity = 0",
    todaySales: `
      SELECT 
        COUNT(*) as count, 
        COALESCE(SUM(total_amount), 0) as revenue 
      FROM sales 
      WHERE DATE(sale_date) = DATE('now')
    `,
    weekSales: `
      SELECT 
        COUNT(*) as count, 
        COALESCE(SUM(total_amount), 0) as revenue 
      FROM sales 
      WHERE sale_date >= DATE('now', '-7 days')
    `,
    monthSales: `
      SELECT 
        COUNT(*) as count, 
        COALESCE(SUM(total_amount), 0) as revenue 
      FROM sales 
      WHERE sale_date >= DATE('now', '-30 days')
    `,
    topSellingProduct: `
      SELECT 
        p.name,
        SUM(s.quantity_sold) as total_sold,
        SUM(s.total_amount) as total_revenue
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.sale_date >= DATE('now', '-30 days')
      GROUP BY s.product_id, p.name
      ORDER BY total_sold DESC
      LIMIT 1
    `
  };
  
  const results = {};
  let completed = 0;
  const totalQueries = Object.keys(queries).length;
  
  Object.entries(queries).forEach(([key, sql]) => {
    db.get(sql, (err, row) => {
      if (err) {
        console.error(`Analytics query error (${key}):`, err);
        results[key] = key === 'topSellingProduct' ? null : { count: 0, total: 0, revenue: 0 };
      } else {
        results[key] = row;
      }
      
      completed++;
      if (completed === totalQueries) {
        res.json(results);
      }
    });
  });
});

app.get('/api/analytics/sales-trend', (req, res) => {
  const { period = '30' } = req.query;
  
  const sql = `
    SELECT 
      DATE(sale_date) as date,
      COUNT(*) as sales_count,
      SUM(quantity_sold) as items_sold,
      SUM(total_amount) as revenue,
      COUNT(DISTINCT product_id) as unique_products
    FROM sales 
    WHERE sale_date >= DATE('now', '-${parseInt(period)} days')
    GROUP BY DATE(sale_date)
    ORDER BY date ASC
  `;
  
  db.all(sql, (err, rows) => {
    if (err) {
      console.error('Sales trend error:', err);
      return res.status(500).json({ error: 'Failed to fetch sales trend' });
    }
    res.json(rows);
  });
});

app.get('/api/analytics/category-distribution', (req, res) => {
  const sql = `
    SELECT 
      p.category,
      COUNT(DISTINCT p.id) as product_count,
      SUM(i.quantity) as total_inventory,
      SUM(i.quantity * p.sell_price) as total_value,
      AVG(p.sell_price) as avg_price,
      MIN(p.sell_price) as min_price,
      MAX(p.sell_price) as max_price
    FROM products p
    JOIN inventory i ON p.id = i.product_id
    GROUP BY p.category
    ORDER BY total_value DESC
  `;
  
  db.all(sql, (err, rows) => {
    if (err) {
      console.error('Category distribution error:', err);
      return res.status(500).json({ error: 'Failed to fetch category distribution' });
    }
    res.json(rows);
  });
});

app.get('/api/analytics/top-products', (req, res) => {
  const { period = '30', metric = 'revenue', limit = 10 } = req.query;
  
  const orderBy = metric === 'quantity' ? 'total_sold' : 'total_revenue';
  
  const sql = `
    SELECT 
      p.id,
      p.name,
      p.category,
      p.sell_price,
      SUM(s.quantity_sold) as total_sold,
      SUM(s.total_amount) as total_revenue,
      COUNT(s.id) as transaction_count,
      AVG(s.quantity_sold) as avg_quantity_per_sale
    FROM sales s
    JOIN products p ON s.product_id = p.id
    WHERE s.sale_date >= DATE('now', '-${parseInt(period)} days')
    GROUP BY s.product_id, p.id, p.name, p.category, p.sell_price
    ORDER BY ${orderBy} DESC
    LIMIT ?
  `;
  
  db.all(sql, [parseInt(limit)], (err, rows) => {
    if (err) {
      console.error('Top products error:', err);
      return res.status(500).json({ error: 'Failed to fetch top products' });
    }
    res.json(rows);
  });
});

// Alerts Routes
app.get('/api/alerts', authenticateToken, (req, res) => {
  const { status = 'active', type } = req.query;
  
  let sql = `
    SELECT 
      a.*,
      p.name as product_name,
      p.category,
      p.sku,
      i.quantity as current_quantity,
      i.reorder_level
    FROM alerts a
    JOIN products p ON a.product_id = p.id
    LEFT JOIN inventory i ON a.product_id = i.product_id
    WHERE a.status = ?
  `;
  
  const params = [status];
  
  if (type) {
    sql += ' AND a.alert_type = ?';
    params.push(type);
  }
  
  sql += ' ORDER BY a.priority DESC, a.created_at DESC';
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Alerts fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch alerts' });
    }
    res.json(rows);
  });
});

app.put('/api/alerts/:id/resolve', authenticateToken, (req, res) => {
  const { reason } = req.body;
  
  db.run(
    `UPDATE alerts SET 
     status = 'resolved', 
     resolved_at = CURRENT_TIMESTAMP, 
     resolved_by = ? 
     WHERE id = ?`,
    [req.user.username, req.params.id],
    function(err) {
      if (err) {
        console.error('Alert resolution error:', err);
        return res.status(500).json({ error: 'Failed to resolve alert' });
      }
      
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Alert not found' });
      }
      
      console.log(`✅ Alert resolved: ID ${req.params.id} by ${req.user.username}`);
      res.json({ message: 'Alert resolved successfully' });
    }
  );
});

// Stock Movement Routes
app.get('/api/stock-movements', authenticateToken, (req, res) => {
  const { product_id, movement_type, limit = 50 } = req.query;
  
  let sql = `
    SELECT 
      sm.*,
      p.name as product_name,
      p.sku,
      u.username as user_name
    FROM stock_movements sm
    JOIN products p ON sm.product_id = p.id
    LEFT JOIN users u ON sm.user_id = u.id
    WHERE 1=1
  `;
  
  const params = [];
  
  if (product_id) {
    sql += ' AND sm.product_id = ?';
    params.push(product_id);
  }
  
  if (movement_type) {
    sql += ' AND sm.movement_type = ?';
    params.push(movement_type);
  }
  
  sql += ' ORDER BY sm.created_at DESC LIMIT ?';
  params.push(parseInt(limit));
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Stock movements fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch stock movements' });
    }
    res.json(rows);
  });
});

// Helper Functions
function createLowStockAlert(productId, currentQuantity, reorderLevel) {
  // Check if alert already exists
  db.get(
    "SELECT id FROM alerts WHERE product_id = ? AND alert_type = 'low_stock' AND status = 'active'",
    [productId],
    (err, existingAlert) => {
      if (err || existingAlert) return;
      
      // Get product name for alert message
      db.get(
        "SELECT name FROM products WHERE id = ?",
        [productId],
        (err, product) => {
          if (err || !product) return;
          
          const priority = currentQuantity === 0 ? 'critical' : 'high';
          const alertType = currentQuantity === 0 ? 'out_of_stock' : 'low_stock';
          const message = currentQuantity === 0 
            ? `${product.name} is out of stock`
            : `${product.name} is running low (${currentQuantity} remaining, reorder at ${reorderLevel})`;
          
          db.run(
            `INSERT INTO alerts (product_id, alert_type, message, priority) 
             VALUES (?, ?, ?, ?)`,
            [productId, alertType, message, priority],
            function(err) {
              if (err) {
                console.error('Error creating alert:', err);
              } else {
                console.log(`🚨 ${priority.toUpperCase()} alert created: ${message}`);
              }
            }
          );
        }
      );
    }
  );
}

// Automated daily stock check (runs at 9 AM every day)
cron.schedule('0 9 * * *', () => {
  console.log('🔄 Running scheduled daily stock check...');
  
  const sql = `
    SELECT 
      p.id,
      p.name,
      i.quantity,
      i.reorder_level
    FROM products p
    JOIN inventory i ON p.id = i.product_id
    WHERE i.quantity <= i.reorder_level
  `;
  
  db.all(sql, (err, rows) => {
    if (err) {
      console.error('Scheduled stock check error:', err);
      return;
    }
    
    if (rows.length === 0) {
      console.log('✅ Stock check complete. No low-stock items found.');
      return;
    }
    
    rows.forEach(product => {
      createLowStockAlert(product.id, product.quantity, product.reorder_level);
    });
    
    console.log(`📊 Stock check complete. Found ${rows.length} items needing attention.`);
  });
});

// Weekly sales report (runs Sunday at 8 PM)
cron.schedule('0 20 * * 0', () => {
  console.log('📈 Generating weekly sales report...');
  
  const sql = `
    SELECT 
      COUNT(*) as total_transactions,
      SUM(quantity_sold) as total_items_sold,
      SUM(total_amount) as total_revenue,
      AVG(total_amount) as avg_transaction_value
    FROM sales 
    WHERE sale_date >= DATE('now', '-7 days')
  `;
  
  db.get(sql, (err, stats) => {
    if (err) {
      console.error('Weekly report error:', err);
      return;
    }
    
    console.log('📊 Weekly Sales Summary:');
    console.log(`   Transactions: ${stats.total_transactions}`);
    console.log(`   Items Sold: ${stats.total_items_sold}`);
    console.log(`   Revenue: ${stats.total_revenue?.toFixed(2) || '0.00'}`);
    console.log(`   Avg Transaction: ${stats.avg_transaction_value?.toFixed(2) || '0.00'}`);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    ...(NODE_ENV === 'development' && { details: err.message })
  });
});

// Serve React app in production
if (NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Initialize database and start server
async function startServer() {
  try {
    await initializeDatabase();
    
    app.listen(PORT, () => {
      console.log('🚀 Harvard Shop Inventory Server Started!');
      console.log('');
      console.log(`📍 Environment: ${NODE_ENV}`);
      console.log(`🌐 Server: http://localhost:${PORT}`);
      console.log(`📊 API: http://localhost:${PORT}/api`);
      console.log(`💾 Database: ${DB_PATH}`);
      console.log('');
      console.log('🎯 Ready to transform your Harvard Shop experience!');
      console.log('');
      if (NODE_ENV === 'development') {
        console.log('👤 Default login: admin / password');
        console.log('🔧 Run "npm run client" to start frontend');
      }
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server gracefully...');
  
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('❌ Error closing database:', err.message);
      } else {
        console.log('✅ Database connection closed');
      }
      
      console.log('👋 Server shutdown complete');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  console.log('🔄 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer();