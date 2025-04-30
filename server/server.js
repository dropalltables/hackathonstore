// hackathon store server

const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const qs = require('querystring');
const webpush = require('web-push');
const config = require('./config');

const app = express();
const PORT = config.PORT;

// DigiKey API credentials from config
const DIGIKEY_CLIENT_ID = config.digikey.CLIENT_ID;
const DIGIKEY_CLIENT_SECRET = config.digikey.CLIENT_SECRET;
const DIGIKEY_API_URL = config.digikey.API_URL;
const TOKEN_URL = config.digikey.TOKEN_URL;

// Web Push configuration
const vapidKeys = {
  publicKey: config.webpush.VAPID_PUBLIC_KEY,
  privateKey: config.webpush.VAPID_PRIVATE_KEY
};

// If VAPID keys are not set, generate them as fallback
if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  console.warn('VAPID keys not found in configuration! Generating temporary keys...');
  const generatedKeys = webpush.generateVAPIDKeys();
  vapidKeys.publicKey = generatedKeys.publicKey;
  vapidKeys.privateKey = generatedKeys.privateKey;
  
  console.log('Generated VAPID Keys:');
  console.log('Public Key:', vapidKeys.publicKey);
  console.log('Private Key:', vapidKeys.privateKey);
  console.log('Please add these to your .env file for better security');
}

// Configure web-push
webpush.setVapidDetails(
  'mailto:' + config.webpush.CONTACT_EMAIL,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// DigiKey access token data
let digikeyAccessToken = null;
let tokenExpiry = null;

// Middleware
// Enable CORS for all origins
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Store data
let allItems = [];
let orders = {};

// Store push subscriptions
let pushSubscriptions = {};

// Function to get DigiKey access token
async function getDigiKeyAccessToken() {
  // Check if current token is still valid
  if (digikeyAccessToken && tokenExpiry && new Date() < tokenExpiry) {
    return digikeyAccessToken;
  }

  try {
    console.log('Requesting new DigiKey access token...');
    
    const response = await axios.post(TOKEN_URL, qs.stringify({
      client_id: DIGIKEY_CLIENT_ID,
      client_secret: DIGIKEY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    digikeyAccessToken = response.data.access_token;
    // Set expiry time with a buffer of 5 minutes
    tokenExpiry = new Date(Date.now() + (response.data.expires_in - 300) * 1000);
    
    console.log('DigiKey access token obtained successfully');
    return digikeyAccessToken;
  } catch (error) {
    console.error('Error obtaining DigiKey access token:', error.response?.data || error.message);
    throw error;
  }
}

// Function to fetch product details from DigiKey API
async function fetchDigiKeyProductDetails(partNumber) {
  try {
    const token = await getDigiKeyAccessToken();
    
    const response = await axios.get(`${DIGIKEY_API_URL}/products/v4/search/${partNumber}/productdetails`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-DIGIKEY-Client-Id': DIGIKEY_CLIENT_ID,
        'X-DIGIKEY-Locale-Site': 'US',
        'X-DIGIKEY-Locale-Language': 'en',
        'X-DIGIKEY-Locale-Currency': 'USD'
      }
    });
    
    return response.data.Product;
  } catch (error) {
    console.error(`Error fetching DigiKey product details for ${partNumber}:`, 
      error.response?.data?.detail || error.message);
    return null;
  }
}

// Load and parse CSV files
async function loadData() {
  console.log('Loading data from CSV files and Digikey API...');
  
  // Load custom items
  const customItems = [];
  await new Promise((resolve, reject) => {
    let lineCounter = 1; // Header is line 1
    fs.createReadStream(path.join(__dirname, 'custom.csv'))
      .pipe(csv())
      .on('data', (row) => {
        lineCounter++;
        
        // Validate required fields
        if (!row.price) {
          throw new Error(`Missing price for item ${row['part number']} at line ${lineCounter} in custom.csv`);
        }
        
        if (!row.stock) {
          throw new Error(`Missing stock for item ${row['part number']} at line ${lineCounter} in custom.csv`);
        }
        
        customItems.push({
          id: row['part number'],
          name: row.name,
          description: row.description,
          datasheet: row.datasheet,
          manufacturer: row.manufacturer,
          imageUrl: row['image url'],
          type: 'custom',
          price: parseFloat(row.price),
          stock: parseInt(row.stock),
        });
      })
      .on('error', (error) => {
        console.error('Error processing custom.csv:', error.message);
        reject(error);
      })
      .on('end', () => {
        console.log(`Loaded ${customItems.length} custom items`);
        resolve();
      });
  });

  // Load Digikey items
  const digikeyItems = [];
  await new Promise((resolve, reject) => {
    let lineCounter = 1; // Header is line 1
    fs.createReadStream(path.join(__dirname, 'digikey.csv'))
      .pipe(csv())
      .on('data', (row) => {
        lineCounter++;
        
        // Validate required fields
        if (!row.price) {
          throw new Error(`Missing price for item ${row.digikey_part_number} at line ${lineCounter} in digikey.csv`);
        }
        
        if (!row.stock) {
          throw new Error(`Missing stock for item ${row.digikey_part_number} at line ${lineCounter} in digikey.csv`);
        }
        
        digikeyItems.push({
          id: row.digikey_part_number,
          price: parseFloat(row.price),
          stock: parseInt(row.stock),
          type: 'digikey'
        });
      })
      .on('error', (error) => {
        console.error('Error processing digikey.csv:', error.message);
        reject(error);
      })
      .on('end', () => {
        console.log(`Loaded ${digikeyItems.length} Digikey items`);
        resolve();
      });
  });

  // Try to load from cache first if available
  let cachedData = null;
  try {
    const cacheFile = path.join(__dirname, 'items_cache.json');
    if (fs.existsSync(cacheFile)) {
      const cacheStats = fs.statSync(cacheFile);
      // Use cache if it's less than 24 hours old
      if ((Date.now() - cacheStats.mtimeMs) < 24 * 60 * 60 * 1000) {
        console.log('Loading cached DigiKey product data...');
        cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
    }
  } catch (error) {
    console.log('No valid cache found, will fetch fresh data');
  }

  // Process DigiKey items - either from cache or API
  for (const item of digikeyItems) {
    const cachedItem = cachedData?.find(cached => cached.id === item.id);
    
    if (cachedItem) {
      // Use cached data but keep current price and stock
      Object.assign(item, {
        name: cachedItem.name,
        description: cachedItem.description,
        manufacturer: cachedItem.manufacturer,
        datasheet: cachedItem.datasheet,
        imageUrl: cachedItem.imageUrl
      });
      console.log(`Using cached data for DigiKey part ${item.id}`);
    } else {
      try {
        console.log(`Fetching data for DigiKey part ${item.id}...`);
        // Add delay between API calls to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const productDetails = await fetchDigiKeyProductDetails(item.id);
        
        if (productDetails) {
          Object.assign(item, {
            name: productDetails.ManufacturerProductNumber,
            description: productDetails.Description?.ProductDescription || 'No description available',
            manufacturer: productDetails.Manufacturer?.Name || 'DigiKey',
            datasheet: productDetails.DatasheetUrl || '#',
            imageUrl: productDetails.PhotoUrl || 'img/placeholder.svg'
          });
          console.log(`Successfully fetched data for DigiKey part ${item.id}`);
        } else {
          // Fallback if API fails
          Object.assign(item, {
            name: `DigiKey Part ${item.id}`,
            description: 'No description available',
            manufacturer: 'DigiKey',
            datasheet: '#',
            imageUrl: 'img/placeholder.svg'
          });
          console.log(`Using fallback data for DigiKey part ${item.id}`);
        }
      } catch (error) {
        console.error(`Error processing DigiKey part ${item.id}:`, error.message);
        // Add default data if API fails
        Object.assign(item, {
          name: `DigiKey Part ${item.id}`,
          description: 'No description available',
          manufacturer: 'Unknown',
          datasheet: '#',
          imageUrl: 'img/placeholder.svg'
        });
      }
    }
  }

  // Combine both types of items
  allItems = [...customItems, ...digikeyItems];
  
  // Save to JSON files for quick access
  fs.writeFileSync(
    path.join(__dirname, 'items.json'),
    JSON.stringify(allItems, null, 2)
  );
  
  // Also update the cache
  fs.writeFileSync(
    path.join(__dirname, 'items_cache.json'),
    JSON.stringify(digikeyItems, null, 2)
  );
  
  console.log(`Total items loaded: ${allItems.length}`);

  // Load existing orders if available
  try {
    const ordersData = fs.readFileSync(path.join(__dirname, 'orders.json'), 'utf8');
    orders = JSON.parse(ordersData);
    console.log(`Loaded ${Object.keys(orders).length} existing orders`);
  } catch (error) {
    console.log('No existing orders found, starting with empty orders');
    orders = {};
  }
}

// API Endpoints - Update paths with config prefix
const API_PREFIX = config.API_PREFIX;

// Add these functions for inventory management

/**
 * Check if there's sufficient stock for an order
 * @param {Object} order - The order with items to check
 * @returns {boolean} Whether all items are in stock
 */
function checkOrderStock(order) {
  // For each item in the order, check if there's enough stock
  for (const orderItem of order.items) {
    const product = allItems.find(item => item.id === orderItem.id);
    if (!product || product.stock < orderItem.quantity) {
      return false;
    }
  }
  return true;
}

/**
 * Reserve stock for an order (reduce available stock)
 * @param {Object} order - The order to reserve stock for
 */
function reserveStock(order) {
  for (const orderItem of order.items) {
    const product = allItems.find(item => item.id === orderItem.id);
    if (product) {
      product.stock -= orderItem.quantity;
    }
  }
  // Save updated stock to persistent storage
  fs.writeFileSync(
    path.join(__dirname, 'items.json'),
    JSON.stringify(allItems, null, 2)
  );
}

/**
 * Return stock for an order (increase available stock)
 * @param {Object} order - The order to return stock for
 */
function returnStock(order) {
  for (const orderItem of order.items) {
    const product = allItems.find(item => item.id === orderItem.id);
    if (product) {
      product.stock += orderItem.quantity;
    }
  }
  // Save updated stock to persistent storage
  fs.writeFileSync(
    path.join(__dirname, 'items.json'),
    JSON.stringify(allItems, null, 2)
  );
}

// Push notification endpoints
app.get(`${API_PREFIX}/notifications/vapid-public-key`, (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post(`${API_PREFIX}/notifications/register`, (req, res) => {
  const { orderId, username, subscription } = req.body;
  
  if (!orderId || !subscription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    // Store the subscription for this order
    pushSubscriptions[orderId] = {
      username: username || 'Anonymous',
      subscription,
      registeredAt: new Date().toISOString()
    };
    
    // Save subscriptions to file
    saveSubscriptions();
    
    // Send an initial notification to confirm registration
    const payload = JSON.stringify({
      title: 'Notifications Enabled',
      body: `You'll receive updates about order #${orderId}`,
      orderId
    });
    
    webpush.sendNotification(subscription, payload)
      .catch(error => console.error('Error sending test notification:', error));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error registering subscription:', error);
    res.status(500).json({ error: 'Failed to register for notifications' });
  }
});

// Send push notification based on order status
function sendOrderNotification(orderId, status, note) {
  const subscription = pushSubscriptions[orderId]?.subscription;
  if (!subscription) {
    return;
  }
  
  let title, body;
  
  if (status === 'approved') {
    title = `Order #${orderId.slice(0, 8)} Approved! 🎉`;
    body = note || 'Your order has been approved and will be prepared soon.';
  } else if (status === 'denied') {
    title = `Order #${orderId.slice(0, 8)} Denied`;
    // Use the provided note as the reason if available, otherwise use a generic message
    body = note ? `Reason: ${note}` : 'Your order has been denied.';
  } else {
    title = `Order #${orderId.slice(0, 8)} Updated`;
    body = note || `Your order status is now: ${status}`;
  }
  
  const payload = JSON.stringify({
    title,
    body,
    orderId,
    url: `/client/order.html?id=${orderId}`
  });
  
  webpush.sendNotification(subscription, payload)
    .then(() => {
      console.log(`Notification sent for order ${orderId}`);
    })
    .catch(error => {
      console.error(`Error sending notification for order ${orderId}:`, error);
      
      // If subscription is no longer valid, remove it
      if (error.statusCode === 410) {
        console.log(`Removing invalid subscription for order ${orderId}`);
        delete pushSubscriptions[orderId];
        saveSubscriptions();
      }
    });
}

// Save subscriptions to file
function saveSubscriptions() {
  fs.writeFileSync(
    path.join(__dirname, 'subscriptions.json'),
    JSON.stringify(pushSubscriptions, null, 2)
  );
}

// Load subscriptions from file
function loadSubscriptions() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'subscriptions.json'), 'utf8');
    pushSubscriptions = JSON.parse(data);
    console.log(`Loaded ${Object.keys(pushSubscriptions).length} push subscriptions`);
  } catch (error) {
    console.log('No subscription data found, starting with empty subscriptions');
    pushSubscriptions = {};
  }
}

// Get all items
app.get(`${API_PREFIX}/items`, (req, res) => {
  res.json(allItems);
});

// Get a specific item by ID
app.get(`${API_PREFIX}/items/:id`, (req, res) => {
  const item = allItems.find(item => item.id === req.params.id);
  if (item) {
    res.json(item);
  } else {
    res.status(404).json({ error: 'Item not found' });
  }
});

// Place an order
app.post(`${API_PREFIX}/orders`, (req, res) => {
  const { username, cart } = req.body;
  
  if (!username || !cart || !Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'Invalid order data' });
  }

  // Generate order ID
  const orderId = uuidv4();
  
  // Create order
  const order = {
    id: orderId,
    username,
    items: cart,
    totalPrice: cart.reduce((sum, item) => sum + (item.price * item.quantity), 0),
    status: 'pending',
    timestamp: new Date().toISOString(),
    statusHistory: [
      {
        status: 'pending',
        timestamp: new Date().toISOString(),
        note: 'Order placed'
      }
    ]
  };

  // Check stock availability before accepting the order
  if (!checkOrderStock(order)) {
    return res.status(400).json({ error: 'Some items are out of stock' });
  }
  
  // Save order
  orders[orderId] = order;
  saveOrders();
  
  res.status(201).json({ orderId, order });
});

// Get order by ID
app.get(`${API_PREFIX}/orders/:id`, (req, res) => {
  const order = orders[req.params.id];
  if (order) {
    res.json(order);
  } else {
    res.status(404).json({ error: 'Order not found' });
  }
});

// Update order status (admin only)
app.put(`${API_PREFIX}/orders/:id`, (req, res) => {
  const { adminCode, status, note } = req.body;
  const orderId = req.params.id;
  
  // Check admin code - in a real app, use proper authentication
  if (adminCode !== config.ADMIN_CODE) {
    return res.status(403).json({ error: 'Invalid admin code' });
  }
  
  const order = orders[orderId];
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  
  if (status !== 'approved' && status !== 'denied') {
    return res.status(400).json({ error: 'Status must be approved or denied' });
  }
  
  // Check stock again before approving
  if (status === 'approved' && !checkOrderStock(order)) {
    return res.status(400).json({ error: 'Cannot approve order, some items are out of stock' });
  }
  
  // Update order status
  order.status = status;
  order.statusHistory.push({
    status,
    timestamp: new Date().toISOString(),
    note: note || `Order ${status}`
  });
  
  // Manage stock based on status change
  if (status === 'approved') {
    reserveStock(order);
  } else if (status === 'denied' && order.status === 'pending') {
    // No need to return stock for denied orders since we're not reserving on order creation
  }
  
  saveOrders();
  
  // Send push notification if user registered for notifications
  sendOrderNotification(orderId, status, note);
  
  res.json({ success: true, order });
});

// Get all orders (admin only)
app.get(`${API_PREFIX}/orders`, (req, res) => {
  const { adminCode } = req.query;
  
  // Check admin code - in a real app, use proper authentication
  if (adminCode !== config.ADMIN_CODE) {
    return res.status(403).json({ error: 'Invalid admin code' });
  }
  
  res.json(orders);
});

// Save orders to JSON file
function saveOrders() {
  fs.writeFileSync(
    path.join(__dirname, 'orders.json'),
    JSON.stringify(orders, null, 2)
  );
}

// Start the server
async function startServer() {
  try {
    await loadData();
    loadSubscriptions(); // Load stored push subscriptions
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`API available at http://localhost:${PORT}${API_PREFIX}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
