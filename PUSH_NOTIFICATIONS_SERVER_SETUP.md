# Server-Side Push Setup Guide

This guide explains how to enable server-side push notifications for the app.

## Overview

The app is ready to receive push notifications from a server. To enable this feature end-to-end, you need:

1. ✓ **Client Side** (Already Implemented)
   - Service Worker with `push` event handler
   - PushManager subscription ready
   - Notification permissions system

2. **Server Side** (You Need to Implement)
   - VAPID key pair generation
   - Subscription endpoint storage
   - Push message sending

---

## Step 1: Generate VAPID Keys

VAPID (Voluntary Application Server Identification) keys identify your application to the push service.

### Using Node.js web-push

```bash
npm install web-push
```

Then generate keys:

```javascript
const webpush = require('web-push');

// Generate VAPID keys (do this once, save them)
const vapidKeys = webpush.generateVAPIDKeys();

console.log('Public Key:', vapidKeys.publicKey);
console.log('Private Key:', vapidKeys.privateKey);

// Store these securely:
// PUBLIC KEY: Share with client app
// PRIVATE KEY: Keep on server only (never expose to client)
```

**Example Output**:
```
Public Key: BGpxxxx...xxxxx
Private Key: Axxxxx...xxxxx
```

### Save Your Keys

Store them safely:
- **Public Key**: Can be in client code (share with app)
- **Private Key**: Environment variable on server (secret)

---

## Step 2: Update Client App with Public Key

Add your public VAPID key to the app so users can subscribe to push.

### In `index.html` (Optional: Auto-Subscribe)

Find the code that runs on app load and add:

```javascript
// After app loads, auto-request notification + push subscription
(async function setupPushOnLoad() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      // Ask user for notification permission
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        // Subscribe to push notifications
        const vapidPublicKey = 'YOUR_PUBLIC_KEY_HERE'; // Replace with your key
        const result = await window.requestNotificationAndPush(vapidPublicKey);
        if (result.ok && result.subscription) {
          console.log('✓ Push subscribed:', result.subscription);
          // Send subscription to server to save
          await sendSubscriptionToServer(result.subscription);
        }
      }
    }
  } catch (e) {
    console.warn('Push setup failed:', e);
  }
})();

// Helper to send subscription to server
async function sendSubscriptionToServer(subscription) {
  try {
    const response = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription })
    });
    if (!response.ok) throw new Error('Server error: ' + response.status);
    console.log('✓ Subscription saved on server');
  } catch (err) {
    console.error('Failed to save subscription:', err);
  }
}
```

### Or: Let Users Opt-In (Recommended)

In settings or profile page, add a "Enable Notifications" button:

```html
<button id="enableNotificationsBtn">🔔 Enable Notifications</button>

<script>
document.getElementById('enableNotificationsBtn').onclick = async function() {
  try {
    const vapidPublicKey = 'YOUR_PUBLIC_KEY_HERE'; // Replace with your key
    const result = await window.requestNotificationAndPush(vapidPublicKey);
    
    if (result.ok) {
      if (result.subscription) {
        alert('✓ Notifications enabled!');
        // Send subscription to server
        await sendSubscriptionToServer(result.subscription);
      } else {
        alert('Notifications enabled (push not configured on server yet)');
      }
    } else {
      alert('❌ Permission denied');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
};
</script>
```

---

## Step 3: Server - Receive & Store Subscriptions

Create a server endpoint to receive and save subscriptions from clients.

### Node.js/Express Example

```javascript
const express = require('express');
const app = express();

// Store subscriptions in memory (use database in production)
const subscriptions = new Set();

// Endpoint to receive subscriptions
app.post('/api/subscribe', express.json(), (req, res) => {
  try {
    const { subscription } = req.body;
    
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    
    // Save subscription (use database)
    subscriptions.add(JSON.stringify(subscription));
    
    console.log('✓ Subscription saved:', subscription.endpoint);
    res.json({ success: true, message: 'Subscription saved' });
  } catch (err) {
    console.error('Error saving subscription:', err);
    res.status(500).json({ error: err.message });
  }
});

// For database (better approach):
// app.post('/api/subscribe', async (req, res) => {
//   const { subscription, userId } = req.body;
//   await db.subscriptions.upsert({
//     userId,
//     endpoint: subscription.endpoint,
//     auth: subscription.keys.auth,
//     p256dh: subscription.keys.p256dh,
//     expirationTime: subscription.expirationTime
//   });
//   res.json({ success: true });
// });
```

---

## Step 4: Server - Send Push Notifications

When you want to send a notification to a user, use the subscription to send a push message.

### Send Push to One User

```javascript
const webpush = require('web-push');

// Configure with your VAPID keys
webpush.setVapidDetails(
  'mailto:your-email@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Send push notification
async function sendPushNotification(subscription, message) {
  try {
    const payload = JSON.stringify({
      title: message.title || 'نوتیفیکیشن جدید',
      body: message.body || 'یک پیام جدید دریافت کردید',
      icon: message.icon || '/assets/icons/icon-192.png',
      badge: message.badge || '/assets/icons/icon-192.png',
      tag: message.tag || 'notification',
      data: message.data || {}
    });
    
    await webpush.sendNotification(subscription, payload);
    console.log('✓ Push sent successfully');
  } catch (err) {
    if (err.statusCode === 410) {
      console.log('Subscription expired, removing...');
      subscriptions.delete(subscription); // Remove expired subscription
    } else {
      console.error('Push failed:', err);
    }
  }
}

// Example: Send on database event
app.post('/api/notify-user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { title, body } = req.body;
    
    // Get user's subscription from database
    const subscription = await db.subscriptions.findByUserId(userId);
    if (!subscription) {
      return res.status(404).json({ error: 'User not subscribed' });
    }
    
    await sendPushNotification(subscription, { title, body });
    res.json({ success: true, message: 'Push sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Send to All Users

```javascript
async function broadcastNotification(message) {
  const promises = [];
  
  for (const subscriptionStr of subscriptions) {
    const subscription = JSON.parse(subscriptionStr);
    promises.push(sendPushNotification(subscription, message));
  }
  
  const results = await Promise.allSettled(promises);
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`Sent to ${subscriptions.size - failed}/${subscriptions.size} users`);
}

// Example: Broadcast when important event happens
app.post('/api/notify-all', async (req, res) => {
  const { title, body } = req.body;
  await broadcastNotification({ title, body });
  res.json({ success: true });
});
```

---

## Step 5: Test the Flow

### 1. Get Public Key
```javascript
// In console
const pubKey = 'YOUR_PUBLIC_KEY_HERE';
console.log('Public VAPID Key:', pubKey);
```

### 2. Subscribe User
```javascript
// In console
const result = await window.requestNotificationAndPush('YOUR_PUBLIC_KEY_HERE');
console.log('Subscription:', result.subscription);

// Get the subscription object (contains endpoint + keys)
```

### 3. Save on Server
```javascript
// In console
const subscription = (await navigator.serviceWorker.ready).pushManager.getSubscription();
await fetch('/api/subscribe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ subscription })
});
```

### 4. Send Push from Server
```bash
# From server command line
curl -X POST http://localhost:3000/api/notify-all \
  -H "Content-Type: application/json" \
  -d '{
    "title": "تست نوتیفیکیشن",
    "body": "این یک پیام تست است"
  }'
```

### 5. Verify
- Notification appears on desktop/device ✓
- Click notification → App opens ✓
- Notification appears in in-app list ✓

---

## Full Node.js Server Example

```javascript
const express = require('express');
const webpush = require('web-push');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Setup VAPID (from environment or config)
webpush.setVapidDetails(
  'mailto:admin@volleyball.local',
  process.env.VAPID_PUBLIC_KEY || 'YOUR_PUBLIC_KEY',
  process.env.VAPID_PRIVATE_KEY || 'YOUR_PRIVATE_KEY'
);

// Store subscriptions (use database in production)
const subscriptions = new Map(); // userId -> subscription

// 1. Client subscribes
app.post('/api/push/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  subscriptions.set(userId, subscription);
  console.log(`✓ User ${userId} subscribed`);
  res.json({ success: true });
});

// 2. Client unsubscribes
app.post('/api/push/unsubscribe', (req, res) => {
  const { userId } = req.body;
  subscriptions.delete(userId);
  console.log(`✓ User ${userId} unsubscribed`);
  res.json({ success: true });
});

// 3. Send to specific user
app.post('/api/push/send/:userId', async (req, res) => {
  const { userId } = req.params;
  const { title, body, data } = req.body;
  
  const subscription = subscriptions.get(userId);
  if (!subscription) {
    return res.status(404).json({ error: 'User not subscribed' });
  }
  
  try {
    await webpush.sendNotification(subscription, JSON.stringify({
      title, body, data
    }));
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode === 410) subscriptions.delete(userId);
    res.status(500).json({ error: err.message });
  }
});

// 4. Broadcast to all
app.post('/api/push/broadcast', async (req, res) => {
  const { title, body, data } = req.body;
  let sent = 0, failed = 0;
  
  for (const [userId, subscription] of subscriptions) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title, body, data
      }));
      sent++;
    } catch (err) {
      if (err.statusCode === 410) subscriptions.delete(userId);
      failed++;
    }
  }
  
  res.json({ success: true, sent, failed });
});

app.listen(3000, () => {
  console.log('Push server running on port 3000');
});
```

---

## Environment Setup

### .env File
```
VAPID_PUBLIC_KEY=BGpxxxx...xxxxx
VAPID_PRIVATE_KEY=Axxxxx...xxxxx
```

### Docker Example
```dockerfile
FROM node:18
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
ENV VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY
ENV VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY
CMD ["node", "server.js"]
```

---

## Testing Tools

### Postman
1. Create POST request to `http://localhost:3000/api/push/broadcast`
2. Headers: `Content-Type: application/json`
3. Body:
   ```json
   {
     "title": "تست",
     "body": "پیام تستی"
   }
   ```

### curl
```bash
curl -X POST http://localhost:3000/api/push/broadcast \
  -H "Content-Type: application/json" \
  -d '{"title":"تست","body":"پیام تستی"}'
```

### Browser Console
```javascript
// Get public key from server
fetch('/api/vapid-public-key').then(r => r.json()).then(data => {
  console.log('Public Key:', data.publicKey);
  // Use in requestNotificationAndPush()
});
```

---

## Troubleshooting

### "VAPID authentication failed"
- Ensure `VAPID_PRIVATE_KEY` is set on server
- Check key format (should be base64)
- Verify public key matches private key

### "Subscription expired (410)"
- Remove expired subscription from database
- Client should re-subscribe automatically

### "Push failed to send"
- Check network connectivity
- Verify subscription endpoint is valid (starts with https://...)
- Check push service quotas

### Client not receiving notifications
- Verify Notification permission is "granted"
- Check Service Worker is active
- Look for errors in DevTools Application → Service Workers

---

## Production Checklist

- [ ] VAPID keys generated and stored securely
- [ ] Public key added to client app
- [ ] Server endpoint implemented (`/api/subscribe`)
- [ ] Database setup for subscriptions
- [ ] Expired subscription cleanup
- [ ] Rate limiting on push endpoints
- [ ] Error logging for failed pushes
- [ ] User can opt-out of notifications
- [ ] HTTPS required on client
- [ ] Monitoring of push delivery rate

---

## Next Steps

1. Generate VAPID keys (Step 1)
2. Update client with public key
3. Implement server endpoints
4. Test locally
5. Deploy to production
6. Monitor push delivery

**The client app is ready! Only server-side implementation remains.**

