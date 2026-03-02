# ImmoKredit Backend API 🚀

Production-ready REST API für ImmoKredit Finanzierungs-Management mit Pipedrive CRM Integration.

## ✨ Features

✅ **Express + TypeScript** Server
✅ **PostgreSQL** Database mit Prisma ORM
✅ **Pipedrive CRM** Integration (Bi-directional Sync)
✅ **RESTful API** (Leads, Deals, Stats)
✅ **Type-Safe** mit TypeScript
✅ **Auto-Sync** zu Pipedrive bei Lead-Erstellung
✅ **Activity Tracking**
✅ **CORS** für Frontend
✅ **Environment Variables**
✅ **Seed Data** für Testing

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL Database (lokal oder Cloud)
- Pipedrive Account (optional für CRM-Sync)

### 1. Installation

```bash
cd immokredit-backend
npm install
```

### 2. Environment Setup

```bash
cp .env.example .env
```

Editiere `.env` mit deinen Credentials:

```env
# Database (WICHTIG!)
DATABASE_URL="postgresql://user:password@localhost:5432/immokredit"

# Server
PORT=4000

# Pipedrive (Optional - für CRM-Sync)
PIPEDRIVE_API_TOKEN="dein-api-token"
```

### 3. Database Setup

```bash
# Prisma Client generieren
npx prisma generate

# Database Schema pushen
npx prisma db push

# Test-Daten einfügen
npm run db:seed
```

### 4. Server starten

```bash
npm run dev
```

Server läuft auf: **http://localhost:4000**

---

## 📊 Database Setup Options

### Option A: Railway (Empfohlen - Kostenlos!)

```bash
1. Gehe zu railway.app
2. "Start a New Project"
3. "Provision PostgreSQL"
4. Kopiere DATABASE_URL
5. Füge in .env ein
6. npx prisma db push
7. npm run db:seed
```

### Option B: Supabase (Kostenlos)

```bash
1. Gehe zu supabase.com
2. "New Project"
3. Kopiere DATABASE_URL aus Settings
4. Füge in .env ein
5. npx prisma db push
6. npm run db:seed
```

### Option C: Lokal mit Docker

```bash
# PostgreSQL Container starten
docker run --name immokredit-postgres \
  -e POSTGRES_PASSWORD=mypassword \
  -e POSTGRES_DB=immokredit \
  -p 5432:5432 \
  -d postgres:15

# .env anpassen
DATABASE_URL="postgresql://postgres:mypassword@localhost:5432/immokredit"

# Setup
npx prisma db push
npm run db:seed
```

---

## 🔌 API Endpoints

### Health Check
```bash
GET /health
```

### Leads

```bash
# Get all leads
GET /api/leads

# Get single lead
GET /api/leads/:id

# Create lead (+ auto-sync to Pipedrive)
POST /api/leads
Body: {
  "firstName": "Max",
  "lastName": "Mustermann",
  "email": "max@example.com",
  "phone": "+43 664 123 4567",
  "source": "Website",
  "amount": 250000
}

# Update lead
PATCH /api/leads/:id
Body: {
  "firstName": "Max Updated",
  "ampelStatus": "GREEN",
  "score": 85
}

# Delete lead (+ delete from Pipedrive)
DELETE /api/leads/:id
```

### Deals

```bash
# Get all deals
GET /api/deals

# Get single deal
GET /api/deals/:id

# Update deal stage
PATCH /api/deals/:id/stage
Body: {
  "stage": "QUALIFIZIERT"
}
```

### Stats

```bash
# Get dashboard stats
GET /api/stats

Response: {
  "totalLeads": 47,
  "greenLeads": 12,
  "yellowLeads": 25,
  "redLeads": 10,
  "activeDeals": 14,
  "automationsToday": 89
}
```

---

## 🧪 Testing mit cURL

### Create Lead

```bash
curl -X POST http://localhost:4000/api/leads \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "User",
    "email": "test@example.com",
    "phone": "+43 664 999 9999",
    "source": "API Test",
    "amount": 200000
  }'
```

### Get All Leads

```bash
curl http://localhost:4000/api/leads
```

### Get Stats

```bash
curl http://localhost:4000/api/stats
```

---

## 🔗 Pipedrive Integration

### Setup

1. **Pipedrive API Token holen:**
   ```
   - Gehe zu Pipedrive
   - Settings → Personal → API
   - Kopiere deinen API Token
   ```

2. **In .env einfügen:**
   ```env
   PIPEDRIVE_API_TOKEN="dein-token-hier"
   ```

3. **Server neu starten:**
   ```bash
   npm run dev
   ```

### Was passiert automatisch:

```
✅ Lead erstellen → Person + Deal in Pipedrive
✅ Lead updaten → Person in Pipedrive updaten
✅ Lead löschen → Person + Deal in Pipedrive löschen
✅ Activity Tracking in DB
```

### Test ob Pipedrive funktioniert:

```bash
# Lead erstellen
curl -X POST http://localhost:4000/api/leads \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Pipedrive",
    "lastName": "Test",
    "email": "test@pipedrive.com",
    "phone": "+43 664 777 7777",
    "source": "API",
    "amount": 300000
  }'

# Dann in Pipedrive nachsehen → Neuer Lead sollte da sein! 🎉
```

---

## 📁 Projekt-Struktur

```
immokredit-backend/
├── prisma/
│   ├── schema.prisma          # Database Schema
│   └── seed.ts                # Test-Daten
├── src/
│   ├── controllers/           # Route Controllers
│   │   ├── leads.controller.ts
│   │   ├── deals.controller.ts
│   │   └── stats.controller.ts
│   ├── services/              # Business Logic
│   │   └── leads.service.ts
│   ├── routes/                # API Routes
│   │   ├── leads.routes.ts
│   │   ├── deals.routes.ts
│   │   └── stats.routes.ts
│   ├── integrations/          # External APIs
│   │   └── pipedrive.service.ts
│   └── index.ts               # Server Entry
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 🛠️ Scripts

```bash
# Development
npm run dev              # Start mit Hot Reload

# Build
npm run build           # TypeScript kompilieren
npm start              # Production Server

# Database
npm run db:generate    # Prisma Client generieren
npm run db:push        # Schema zu DB pushen
npm run db:migrate     # Migration erstellen
npm run db:seed        # Test-Daten einfügen
npm run db:studio      # Prisma Studio (DB GUI)
```

---

## 🔐 Test-Daten nach Seed

Nach `npm run db:seed` hast du:

### Users
```
✅ admin@immokredit.at (ADMIN)
✅ agent@immokredit.at (AGENT)
Password: password123
```

### Leads (5 Stück)
```
✅ Maria Schmidt (🟡 Gelb, 🌤 Warm)
✅ Peter Wagner (🔴 Rot, ❄️ Kalt)
✅ Lisa Müller (🟢 Grün, 🔥 Heiß)
✅ Thomas Bauer (🟢 Grün, 🔥 Heiß)
✅ Anna Huber (🟡 Gelb, 🌤 Warm)
```

---

## 🎯 Frontend Integration

### In Frontend (.env):

```env
VITE_API_URL=http://localhost:4000/api
```

### API Service (axios):

```typescript
// frontend/src/services/api.ts
import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
});

// Leads Service
export const leadsService = {
  getAll: () => api.get('/leads'),
  create: (data) => api.post('/leads', data),
  update: (id, data) => api.patch(`/leads/${id}`, data),
  delete: (id) => api.delete(`/leads/${id}`),
};
```

---

## 🐛 Troubleshooting

### Database Connection Error

```bash
# Check DATABASE_URL in .env
# Format: postgresql://user:pass@host:port/dbname

# Test connection
npx prisma db push
```

### Port bereits belegt

```bash
# In .env Port ändern
PORT=4001

# Oder kill den Prozess
# Windows
netstat -ano | findstr :4000
taskkill /PID <PID> /F

# Mac/Linux
lsof -i :4000
kill -9 <PID>
```

### Prisma Client Error

```bash
# Prisma Client neu generieren
npx prisma generate

# Node modules neu installieren
rm -rf node_modules package-lock.json
npm install
```

### Pipedrive Sync funktioniert nicht

```bash
# 1. Check API Token in .env
# 2. Check Server Logs für Errors
# 3. Test Pipedrive API direkt:

curl https://api.pipedrive.com/v1/users/me?api_token=DEIN-TOKEN
```

---

## 📈 Next Steps

### Jetzt implementieren:

1. **Frontend connecten**
   ```
   ✅ API Services erstellen
   ✅ Leads-Page mit echten Daten
   ✅ Create/Edit/Delete Funktionalität
   ```

2. **Authentication hinzufügen**
   ```
   ✅ JWT Token System
   ✅ Login/Register
   ✅ Protected Routes
   ```

3. **Weitere Features**
   ```
   ✅ Documents Upload
   ✅ WhatsApp Integration
   ✅ n8n Webhooks
   ✅ Email Service
   ```

---

## 🚀 Production Deployment

### Railway (Empfohlen)

```bash
1. railway.app → "New Project"
2. "Deploy from GitHub"
3. Environment Variables setzen
4. Deploy!
```

### Heroku

```bash
heroku create immokredit-api
heroku addons:create heroku-postgresql:mini
git push heroku main
```

---

## 📞 Support

Bei Fragen oder Problemen:
- Check Server Logs
- Check DATABASE_URL
- Check Pipedrive API Token

---

**Backend ist ready! 🎉**

**Start mit:** `npm run dev`
**Test mit:** `curl http://localhost:4000/health`
