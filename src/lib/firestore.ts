import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { config } from '../config.js'

let db: Firestore | null = null

export function getDb(): Firestore {
  if (db) return db
  if (!getApps().length) {
    // Emulator needs no service account. A real project uses GOOGLE_APPLICATION_CREDENTIALS.
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      initializeApp({ projectId: config.firebaseProjectId })
    } else {
      initializeApp({
        projectId: config.firebaseProjectId,
        credential: applicationDefault(),
      })
    }
  }
  const firestore = getFirestore()
  firestore.settings({ ignoreUndefinedProperties: true })
  db = firestore
  return firestore
}
