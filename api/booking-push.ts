import type { VercelRequest, VercelResponse } from '@vercel/node'
import * as admin from 'firebase-admin'

// ---- Firebase Admin init (Service Account in env var) ----
if (!admin.apps.length) {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!sa) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON')
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(sa) as admin.ServiceAccount),
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    // Optional: verify Firebase ID token from the iOS Authorization header
    // Format: "Bearer <idToken>"
    const authHeader = req.headers.authorization || ''
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!idToken) return res.status(401).json({ error: 'Missing bearer token' })
    const decoded = await admin.auth().verifyIdToken(idToken)

    const { recipientId, type, title, body, bookingId, ...extra } = req.body || {}
    if (!recipientId || !type || !title || !body || !bookingId) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Fetch recipient device tokens from Firestore
    const db = admin.firestore()
    const USERS_COLLECTION = 'users_v2'  // <- matches your iOS constant
    const userDoc = await db.collection(USERS_COLLECTION).doc(recipientId).get()
    if (!userDoc.exists) return res.status(404).json({ error: 'Recipient not found' })

    const data = userDoc.data() || {}
    // EXPECT one of these shapes; use whichever you store:
    // - data.fcmTokens: string[]    OR
    // - data.deviceTokens: string[]
    const tokens: string[] = (data.fcmTokens || data.deviceTokens || []).filter(Boolean)
    if (!tokens.length) {
      return res.status(200).json({ ok: true, sent: 0, reason: 'no_tokens' })
    }

    // Compose a basic FCM notification
    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification: { title, body },
      data: {
        type,
        bookingId,
        recipientId,
        ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
      },
      apns: {
        payload: {
          aps: { sound: 'default' },
        },
      },
    }

    const resp = await admin.messaging().sendEachForMulticast(message)
    return res.status(200).json({ ok: true, sent: resp.successCount, failed: resp.failureCount })
  } catch (err: any) {
    console.error('booking-push error:', err)
    return res.status(500).json({ error: String(err?.message || err) })
  }
}