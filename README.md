# Mini Event Booking API

Built as a practice project that touches most of the
backend topics: validation, error handling, auth and roles, SQL transactions, pagination, caching,
background jobs, WebSockets, testing and logging.

## Tech stack

| Concern | Tool |
|---|---|
| Server | Node.js 22, Express 5 (ES modules, plain JavaScript) |
| Validation | Zod 4 |
| Relational data (users, events, bookings) | MySQL 8 + Prisma 7 |
| Flexible data (reviews, notification log) | MongoDB + Mongoose |
| Cache and job queue | Redis (ioredis) + BullMQ |
| Scheduled work | node-cron |
| Email | nodemailer (prints to the console unless `SMTP_URL` is set) |
| Outgoing webhooks | node:https + HMAC-SHA256 signing (`node:crypto`), delivered through BullMQ |
| Payments | A provider interface with a fake provider (no account, no money); incoming signed webhooks, refunds |
| Live updates | Socket.io |
| Auth | JWT (jsonwebtoken) + bcrypt |
| Logging | morgan-style access log + request ID on every line |
| Tests | `node:test` + Supertest + socket.io-client |

## Which database stores what

| Database | Stores | Why |
|---|---|---|
| MySQL (Prisma) | Users, Events, Bookings | Linked data that must be exact (seat counts). Needs transactions. |
| MongoDB (Mongoose) | Reviews, Notifications | Flexible, grows fast, no strict links. |

MongoDB cannot check that an `eventId` exists in MySQL, so `createReview` asks MySQL itself before saving.

## Architecture

### The idea in one picture

```mermaid
flowchart TB
    Client(["Client<br/>Postman / Browser / App"])

    subgraph API["One Node process (src/server.js), port 3000"]
        direction TB
        MW["Express app<br/>requestId, json, routes, 404, errorHandler"]
        WS["Socket.io<br/>live seat counts"]
        W["Email worker<br/><i>no HTTP port</i>"]
        WH["Webhook worker<br/><i>no HTTP port</i>"]
        CR["node-cron<br/>events every 10 min,<br/>payment sweep every minute"]
    end

    Client -->|"HTTP /api/..."| MW
    Client <-->|"WebSocket"| WS
    MW -->|"Prisma"| MY[("MySQL<br/>users, events, bookings")]
    MW -->|"Mongoose"| MO[("MongoDB<br/>reviews, notifications")]
    MW -->|"cache get/set, INCR version"| RD[("Redis")]
    MW -->|"queue.add"| RD
    MW -->|"emit seats:update"| WS
    RD -->|"BullMQ job"| W
    W -->|"upsert notification"| MO
    W -->|"look up user email"| MY
    W -->|"send"| SMTP["SMTP server<br/>(console in dev)"]
    RD -->|"webhook job"| WH
    WH -->|"load endpoint"| MY
    WH -->|"delivery log"| MO
    WH -->|"signed POST"| EXT["External receivers<br/>(partner servers)"]
    CR -->|"mark FINISHED, expire unpaid holds, retry refunds"| MY
    CR -->|"INCR version"| RD
    PP["Payment provider<br/>(fake in dev)"] -->|"signed webhook<br/>/api/payments/webhook"| MW
    MW -->|"create order, refund"| PP
```

Note that the worker has **no port**. Nothing calls it: it waits on the Redis queue and pulls work. That is
why a booking request never waits for an email. The write path (booking), the slow work (email) and the read
path (cached event list) are decoupled, so a slow or broken piece does not take the others down. Redis is an
optimisation, not a dependency: if it is down, bookings still work.

### What happens when you book a seat

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API (Express)
    participant M as MySQL
    participant R as Redis
    participant W as Watchers (Socket.io)
    participant Q as Worker
    participant G as MongoDB

    C->>A: POST /api/bookings { eventId, quantity }
    A->>A: requestId, requireAuth, validate
    rect rgb(235, 245, 255)
    Note over A,M: one transaction, all or nothing
    A->>M: SELECT event
    A->>M: UPDATE seatsLeft = seatsLeft - qty WHERE seatsLeft >= qty
    M-->>A: rows changed (0 means sold out, so 409)
    A->>M: INSERT booking (PENDING_PAYMENT, or CONFIRMED if free), price snapshot
    A->>M: SELECT seatsLeft
    A->>M: COMMIT
    end
    A->>R: INCR events:version (cached list is now stale)
    A-)W: seats:update { eventId, seatsLeft }
    alt free event
        A->>R: queue.add booking-confirmed (2s deadline)
        A-->>C: 201 { booking CONFIRMED, payment: null }
        R-->>Q: job delivered
        Q->>G: upsert Notification
        Q->>Q: send email (printed to the console in dev)
    else paid event
        Note over A,C: the seats are only HELD. Confirmation, email and the booking.confirmed webhook wait for the payment (next section)
        A-->>C: 201 { booking PENDING_PAYMENT, payment { orderId, expiresAt } }
    end
```

### Paying for a booking

A paid booking only **holds** the seats. It becomes `CONFIRMED` when the payment provider tells us, by webhook,
that the money arrived. The browser saying "I paid" is never trusted.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (browser or app)
    participant A as API
    participant M as MySQL
    participant P as Payment provider
    participant Q as Queues and sockets

    C->>A: POST /api/bookings
    A->>M: hold seats, booking PENDING_PAYMENT, expires in 15 min
    A->>P: create order (amount from the price snapshot)
    P-->>A: orderId
    A->>M: INSERT payment (CREATED)
    A-->>C: 201 { orderId, expiresAt, checkout }
    C->>P: pay on the provider's checkout
    Note over C,P: card details go to the provider, never to our server
    P->>A: POST /api/payments/webhook payment.succeeded (signed)
    A->>A: verify signature, ignore duplicate event ids
    rect rgb(235, 245, 255)
    Note over A,M: conditional updates only
    A->>M: payment CREATED or FAILED becomes SUCCEEDED
    A->>M: booking PENDING_PAYMENT becomes CONFIRMED
    end
    A-->>P: 200 (stop retrying)
    A->>Q: booking confirmed: email job, booking.confirmed webhook
```

What the webhook route does with every call:

```mermaid
flowchart TB
    IN(["POST /api/payments/webhook<br/>raw body, no JWT"]) --> V{"signature valid<br/>and timestamp fresh?"}
    V -->|"no"| R401["401, nothing stored"]
    V -->|"yes"| J{"valid JSON<br/>of the expected shape?"}
    J -->|"no"| R400["400"]
    J -->|"yes"| D{"event id already in the inbox<br/>and processed?"}
    D -->|"yes"| DUP["200 duplicate, do nothing"]
    D -->|"no"| T{"event type"}
    T -->|"payment.succeeded"| S1{"amount and currency match<br/>what we stored?"}
    S1 -->|"no"| MIS["log an error, do NOT confirm"]
    S1 -->|"yes"| S2["mark payment SUCCEEDED"]
    S2 --> S3{"booking still<br/>PENDING_PAYMENT?"}
    S3 -->|"yes"| CONF["CONFIRMED, then email and webhook"]
    S3 -->|"no, expired or cancelled"| LATE["late payment: refund it"]
    T -->|"payment.failed"| F1["payment FAILED, booking keeps its hold"]
    T -->|"refund.processed"| F2["payment REFUNDED"]
    T -->|"anything else"| IG["ignored"]
    CONF --> ACK["200 and mark the inbox row processed"]
    LATE --> ACK
    MIS --> ACK
    F1 --> ACK
    F2 --> ACK
    IG --> ACK
```

When the booking ends before the money arrives, or after it did, the money goes back:

```mermaid
flowchart LR
    subgraph Ends["A booking can end in three ways"]
        direction TB
        E1["user cancels a paid booking"]
        E2["hold expires, then payment arrives late"]
        E3["user cancels while unpaid, then payment arrives late"]
    end
    E1 --> RULE
    E2 --> RULE
    E3 --> RULE
    RULE["Rule: a SUCCEEDED payment whose booking<br/>is CANCELLED or EXPIRED must be refunded"] --> CLAIM["claim it atomically:<br/>SUCCEEDED becomes REFUND_PENDING"]
    CLAIM --> CALL["refund call to the provider<br/>with an idempotency key"]
    CALL -->|"ok"| WAIT["wait for refund.processed, then REFUNDED"]
    CALL -->|"provider down"| BACK["put back to SUCCEEDED"]
    BACK --> SWEEP["the every-minute sweep finds it and retries"]
    SWEEP --> CLAIM
```

### Why two people can never book the same last seat

The seat check and the subtraction are **one SQL statement**, so MySQL locks the row and makes requests queue up.

```mermaid
sequenceDiagram
    participant A as Request A
    participant M as Event row (seatsLeft = 1)
    participant B as Request B

    A->>M: UPDATE ... WHERE seatsLeft >= 1
    Note over M: row locked by A
    B->>M: UPDATE ... WHERE seatsLeft >= 1
    Note over B,M: B waits for the lock
    M-->>A: 1 row changed (seatsLeft is now 0)
    A->>M: INSERT booking, COMMIT (lock released)
    M-->>B: 0 rows changed (WHERE seatsLeft >= 1 now fails)
    Note over B: B gets 409 Not enough seats
```

The broken way, which this project deliberately avoids, is to read first and write second:

```mermaid
sequenceDiagram
    participant A as Request A
    participant M as Event row (seatsLeft = 1)
    participant B as Request B

    A->>M: SELECT seatsLeft
    B->>M: SELECT seatsLeft
    M-->>A: 1
    M-->>B: 1
    Note over A,B: both see "1 seat left", both pass the check
    A->>M: UPDATE seatsLeft = 0
    B->>M: UPDATE seatsLeft = 0
    Note over A,B: two bookings for one seat
```

### Life of a request

```mermaid
flowchart LR
    In(["Request"]) --> RID["requestId<br/>assign or reuse X-Request-Id"]
    RID --> J["express.json"]
    J --> L["access log"]
    L --> ST["static files"]
    ST --> RT{"route matches?"}
    RT -->|"no"| NF["notFound: AppError 404"]
    RT -->|"yes"| AU["requireAuth<br/>protected routes"]
    AU --> RO["requireRole<br/>admin routes"]
    RO --> V["validate schema"]
    V --> H["controller and service"]
    H --> Out(["JSON response"])

    AU -. "401" .-> EH
    RO -. "403" .-> EH
    V -. "400" .-> EH
    H -. "throws" .-> EH
    NF --> EH["errorHandler<br/>one central place"]
    EH --> Err(["status: error, message, details"])
```

### How the events list is cached

```mermaid
flowchart TB
    G["GET /api/events?city=Raipur&page=1"] --> K["build a key from the validated query"]
    K --> V["read events:version from Redis, e.g. 7"]
    V --> H{"GET events:v7:query"}
    H -->|"hit"| R1["return cached JSON<br/>X-Cache: HIT"]
    H -->|"miss"| DB["query MySQL<br/>findMany and count"]
    DB --> ST["SET events:v7:query, expires in 60s"]
    ST --> R2["return JSON<br/>X-Cache: MISS"]
    V -. "Redis down" .-> DB
```

Clearing the cache never searches for keys. It just bumps the version number:

```mermaid
flowchart LR
    E1["event created, updated or deleted"] --> INC
    E2["booking made or cancelled"] --> INC
    E3["cron marks events FINISHED"] --> INC
    INC["INCR events:version<br/>7 becomes 8"] --> OLD["every events:v7:... key is now unreachable<br/>and expires on its own"]
    INC --> NEW["next request builds events:v8:... and refills the cache"]
```

### Background jobs

```mermaid
flowchart TB
    C["booking committed in MySQL"] --> ADD["addBookingJob"]
    ADD --> TRY{"queue.add finished<br/>within 2 seconds?"}
    TRY -->|"yes"| Q[("Redis queue")]
    TRY -->|"no, Redis is down"| FB["fallback: write the notification<br/>straight to MongoDB, no email"]
    Q --> W["Worker picks up the job"]
    W --> S1["1. upsert Notification in MongoDB<br/>safe to repeat"]
    S1 --> S2["2. send the email<br/>cannot be undone, so it goes last"]
```

A job that throws is retried by BullMQ:

```mermaid
stateDiagram-v2
    [*] --> Waiting: queue.add, jobId is name-bookingId
    Waiting --> Active: worker picks it up
    Active --> Completed: notification saved and email sent
    Active --> Delayed: threw an error on attempt 1 or 2
    Delayed --> Waiting: after 2s, then 4s
    Active --> Failed: threw on attempt 3
    Completed --> [*]
    Failed --> [*]
```

### Live seat counts

```mermaid
sequenceDiagram
    participant P as Page watching event X
    participant S as Socket.io
    participant M as MySQL
    participant A as Booking API
    participant O as Page watching event Y

    P->>S: event:join X
    S->>S: validate the id (uuid)
    S->>M: SELECT seatsLeft of X
    S->>S: join room event:X
    S-->>P: ack { ok: true, seatsLeft: 10 }

    Note over A: someone books 4 seats of X over HTTP
    A->>S: emitSeatsUpdate(X, 6)
    S-->>P: seats:update { eventId: X, seatsLeft: 6 }
    Note over O: gets nothing, it joined a different room
```

### Webhooks: telling other systems what happened

An admin registers a URL. From then on, every matching event is POSTed to it, signed, and retried if it fails.

```mermaid
sequenceDiagram
    autonumber
    participant A as API (booking committed)
    participant M as MySQL
    participant R as Redis
    participant W as Webhook worker
    participant X as Receiver (partner server)
    participant G as MongoDB

    A->>M: find active endpoints subscribed to booking.confirmed
    A->>R: one job per endpoint (jobId = delivery id)
    Note over A: the booking response does not wait for any delivery
    R-->>W: job delivered
    W->>M: load endpoint (url, secret, still active?)
    W->>X: POST body + X-Webhook-Signature (HMAC of timestamp.body)
    alt receiver answers 2xx within 5s
        X-->>W: 200 ok
        W->>G: log SUCCESS
    else non-2xx, timeout or network error
        X-->>W: 500 or no answer
        W->>G: log RETRYING
        W->>R: BullMQ retries later (30s, 1m, 2m, 4m, 8m)
    end
```

What happens to a delivery over time, and to the endpoint itself:

```mermaid
stateDiagram-v2
    direction LR
    state "One delivery" as D {
        [*] --> Attempt: job starts
        Attempt --> SUCCESS: 2xx answer
        Attempt --> RETRYING: failed, attempts left
        RETRYING --> Attempt: after the backoff wait
        Attempt --> FAILED: failed on the last attempt
        Attempt --> SKIPPED: endpoint deleted or disabled meanwhile
    }
    state "One endpoint" as E {
        [*] --> Active: registered
        Active --> Active: a delivery succeeds, failure streak resets to 0
        Active --> Disabled: 5 deliveries in a row end as FAILED
        Disabled --> Active: admin sends PATCH active true
    }
```

Two checks keep the feature safe. The **signature** proves a request came from us, and the **SSRF check**
stops an admin from pointing our server at internal addresses:

```mermaid
flowchart TB
    subgraph Receiver["Receiver checks every request"]
        direction TB
        R1["read the RAW body and the headers"] --> R2{"timestamp within 5 minutes?"}
        R2 -->|"no"| RX["reject with 401 (replay)"]
        R2 -->|"yes"| R3["recompute HMAC-SHA256 of timestamp.body with the secret"]
        R3 --> R4{"equal to X-Webhook-Signature?<br/>(constant-time compare)"}
        R4 -->|"no"| RX2["reject with 401 (forged or tampered)"]
        R4 -->|"yes"| R5{"X-Webhook-Id already seen?"}
        R5 -->|"yes"| R6["reply 200, do nothing (duplicate)"]
        R5 -->|"no"| R7["process it, reply 2xx quickly"]
    end

    subgraph Sender["We check the target URL, twice"]
        direction TB
        S1["admin registers a URL"] --> S2{"https, no credentials,<br/>resolves to a public IP?"}
        S2 -->|"no"| S3["400, not saved"]
        S2 -->|"yes"| S4["saved"]
        S4 --> S5["at delivery time, the connection itself<br/>re-checks the IP it is about to use"]
        S5 --> S6{"still public?"}
        S6 -->|"no, DNS changed"| S7["blocked, counts as a failed attempt"]
        S6 -->|"yes"| S8["send, never follow redirects"]
    end
```

### Data model

MySQL holds the linked, exact data. MongoDB holds the flexible data. The dotted lines are **logical links
only**: MongoDB cannot enforce foreign keys into MySQL, so the code checks them itself.

```mermaid
erDiagram
    USER ||--o{ BOOKING : makes
    EVENT ||--o{ BOOKING : has
    BOOKING ||--o| PAYMENT : "paid by"
    USER ||..o{ REVIEW : writes
    EVENT ||..o{ REVIEW : receives
    USER ||..o{ NOTIFICATION : gets
    WEBHOOKENDPOINT ||..o{ WEBHOOKDELIVERY : receives

    USER {
        string id PK
        string email UK
        string passwordHash
        enum role "USER or ADMIN"
        datetime createdAt
    }
    EVENT {
        string id PK
        string title
        string city
        datetime date
        decimal price
        int totalSeats
        int seatsLeft
        enum status "UPCOMING or FINISHED"
    }
    BOOKING {
        string id PK
        string userId FK
        string eventId FK
        int quantity
        enum status "PENDING_PAYMENT, CONFIRMED, CANCELLED, EXPIRED"
        int amountMinor "price snapshot, minor units"
        string currency
        datetime expiresAt "only while pending"
    }
    PAYMENT {
        string id PK
        string bookingId FK "unique"
        string providerOrderId UK
        string providerPaymentId
        int amountMinor
        enum status "CREATED, FAILED, SUCCEEDED, REFUND_PENDING, REFUNDED"
    }
    PAYMENTWEBHOOKEVENT {
        string providerEventId "unique per provider"
        string type
        json payload
        string result "what we did"
        datetime processedAt
    }
    REVIEW {
        string eventId "unique with userId"
        string userId
        int rating "1 to 5"
        string comment
    }
    NOTIFICATION {
        string userId
        enum type "BOOKING_CONFIRMED and more"
        string message
        object meta
        bool read
    }
    WEBHOOKENDPOINT {
        string id PK
        string url
        string secret "shown once"
        json events
        bool active
        int failureCount
    }
    WEBHOOKDELIVERY {
        string deliveryId "unique"
        string endpointId
        string event
        enum status "SUCCESS, RETRYING, FAILED, SKIPPED"
        int attempts
        int lastStatusCode
    }
```

### Status lifecycles

```mermaid
stateDiagram-v2
    direction LR
    state "Booking" as BK {
        [*] --> PENDING_PAYMENT: paid event, seats held for 15 min
        [*] --> CONFIRMED: free event
        PENDING_PAYMENT --> CONFIRMED: payment.succeeded webhook
        PENDING_PAYMENT --> EXPIRED: hold ran out, cron
        PENDING_PAYMENT --> CANCELLED: cancelled by the user
        CONFIRMED --> CANCELLED: owner or admin cancels, before the event starts
    }
    state "Payment" as PY {
        [*] --> CREATED: order made at the provider
        CREATED --> SUCCEEDED: payment.succeeded
        CREATED --> FAILED: payment.failed
        FAILED --> SUCCEEDED: user retries the same order
        SUCCEEDED --> REFUND_PENDING: booking ended, refund requested
        REFUND_PENDING --> REFUNDED: refund.processed
    }
    state "Event" as EV {
        [*] --> UPCOMING: admin creates it
        UPCOMING --> FINISHED: cron, once its date has passed
    }
```

## Getting started

### Prerequisites
- Node.js 22 or newer
- MySQL 8 running locally
- MongoDB running locally (the server refuses to start without it)
- Redis running locally (optional: without it the API still works, but there is no caching and no email jobs;
  on Windows use Memurai, Docker or WSL)

### Install and configure
```bash
npm install
npx prisma generate
```

Create a `.env` file in the project root:

```env
PORT=3000
NODE_ENV=development

# MySQL. URL-encode special characters in the password (e.g. @ becomes %40)
DATABASE_URL="mysql://root:YOUR_PASSWORD@127.0.0.1:3306/event_booking"

# Optional, these are the defaults
MONGO_URL="mongodb://127.0.0.1:27017/event_booking"
REDIS_URL="redis://127.0.0.1:6379"

JWT_SECRET="use-a-long-random-string-here"
JWT_EXPIRES_IN=1d

# Optional. Without SMTP_URL, emails are printed to the console instead of sent.
# SMTP_URL="smtps://user:pass@smtp.example.com"
# EMAIL_FROM="Event Booking <no-reply@example.com>"

# Payments (all optional, these are the defaults). "fake" needs no account and moves no money;
# it is refused when NODE_ENV=production.
# PAYMENT_PROVIDER=fake
# PAYMENT_WEBHOOK_SECRET="dev-only-fake-payment-webhook-secret"
# BOOKING_HOLD_MINUTES=15
# CURRENCY=INR
```

`.env` is in `.gitignore`. Never commit it.

### Create the tables
```bash
npx prisma migrate dev
```
This creates the `event_booking` database if needed and applies the migrations.

### Run
```bash
npm run dev     # nodemon, auto-restart on changes
npm start       # plain node
```

The API listens on `http://localhost:3000`. Check `GET /health`.

### Make yourself an admin
Signup always creates a normal `USER` (a role in the request body is ignored on purpose). Promote an account
directly in the database, then log in again, because the role is stored inside the token:

```sql
UPDATE event_booking.User SET role = 'ADMIN' WHERE email = 'you@example.com';
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with nodemon |
| `npm start` | Start with node |
| `npm test` | Run the test suite (needs the test database, see below) |
| `npm run test:migrate` | Apply migrations to the test database |

## API reference

All responses use one shape. Success: `{ "status": "success", "data": {...}, "meta": {...} }`.
Errors: `{ "status": "error", "message": "...", "details": [...] }` (`details` only for validation errors).
Protected routes need the header `Authorization: Bearer <token>`.

### Auth
| Method | Path | Access | Notes |
|---|---|---|---|
| POST | `/api/auth/signup` | public | `{ email, password }`, password 8 to 72 chars |
| POST | `/api/auth/login` | public | Returns `{ token, user }` |
| GET | `/api/auth/me` | logged in | Current user |

### Events
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/api/events` | public | Query: `page`, `limit` (max 50), `city`, `q`, `sort` |
| GET | `/api/events/:id` | public | |
| POST | `/api/events` | admin | `{ title, description?, city, date, price, totalSeats }` |
| PATCH | `/api/events/:id` | admin | Any of title, description, city, date, price |
| DELETE | `/api/events/:id` | admin | 409 if the event has bookings |

`sort` accepts `date`, `price`, `createdAt`, with a `-` prefix for descending (`sort=-price`).
The list returns only `UPCOMING` events and includes `meta: { page, limit, total, totalPages }`.
Example: `GET /api/events?city=Raipur&q=music&sort=date&page=1&limit=10`.
The response has an `X-Cache: HIT` or `MISS` header.

### Bookings (all need login)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/bookings` | `{ eventId, quantity }`, quantity 1 to 10. 409 when not enough seats. See below |
| GET | `/api/bookings/me` | My bookings with their payment status, paginated |
| GET | `/api/bookings/:id` | Owner or admin |
| PATCH | `/api/bookings/:id/cancel` | Owner or admin. Gives the seats back and refunds a paid booking |

`POST /api/bookings` on a **paid** event returns `booking.status: "PENDING_PAYMENT"` plus a `payment` object
(`orderId`, `amountMinor`, `currency`, `expiresAt`, `checkout`). The client pays before `expiresAt`, and the
booking turns `CONFIRMED` once the provider's webhook arrives. On a **free** event (price 0) the booking is
`CONFIRMED` immediately and `payment` is `null`. Amounts are integers in minor units (25000 = 250.00).

### Payments
| Method | Path | Notes |
|---|---|---|
| POST | `/api/payments/webhook` | **Called by the payment provider**, not by your users. No JWT, the signature is the authentication. Always answers 2xx once processed |
| POST | `/api/dev/fake-provider/events` | Dev only (fake provider). Logged in. `{ type, orderId }` where `type` is `payment.succeeded`, `payment.failed` or `refund.processed`. Plays the provider for your own orders |

**Try the whole flow locally** (no account, no money):
1. Book a seat on an event with a price: `POST /api/bookings`. Note `payment.orderId`. Status is `PENDING_PAYMENT`.
2. "Pay": `POST /api/dev/fake-provider/events` with `{ "type": "payment.succeeded", "orderId": "<orderId>" }`.
3. `GET /api/bookings/:id`: it is now `CONFIRMED`. The email job and the `booking.confirmed` webhook fire now.
4. Cancel it with `PATCH /api/bookings/:id/cancel`: the seats return and the payment goes to `REFUND_PENDING`.
   Send `{ "type": "refund.processed", ... }` to finish it as `REFUNDED`.
5. To see expiry, book and do nothing: after 15 minutes (or set `BOOKING_HOLD_MINUTES=1`) the seats come back.

**What a real provider would send** to `/api/payments/webhook` is checked by the provider adapter (for the fake
one: headers `X-Fake-Timestamp` and `X-Fake-Signature`, an HMAC of `"<timestamp>.<raw body>"`, using
`PAYMENT_WEBHOOK_SECRET`). A real Razorpay or Stripe adapter would verify their own signature format instead.

### Reviews
| Method | Path | Access | Notes |
|---|---|---|---|
| POST | `/api/events/:eventId/reviews` | logged in | `{ rating 1-5, comment? }`. Requires a confirmed booking. One per user per event |
| GET | `/api/events/:eventId/reviews` | public | Paginated, `meta.avgRating` included |
| DELETE | `/api/reviews/:id` | owner or admin | |

### Notifications (all need login)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/notifications` | Mine, `?unread=true` to filter |
| PATCH | `/api/notifications/:id/read` | Mark one as read |

### Live seats (Socket.io)
Connect to the same host and port as the API.

| Direction | Event | Payload |
|---|---|---|
| client to server | `event:join` | `eventId`, with an ack callback that returns `{ ok, seatsLeft }` or `{ ok: false, error }` |
| client to server | `event:leave` | `eventId` |
| server to client | `seats:update` | `{ eventId, seatsLeft }`, sent after every booking or cancel |

Demo page: open `http://localhost:3000/live-seats.html`, paste an event id, press Watch, then book from
Postman and watch the number change.

### Webhooks (admin only)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/webhooks` | `{ url, events }`. Returns the `secret` **once**, so save it |
| GET | `/api/webhooks` | List endpoints (the secret is never shown again) |
| PATCH | `/api/webhooks/:id` | `{ active?, events? }`. Turning it back on clears the failure streak |
| DELETE | `/api/webhooks/:id` | Remove the endpoint |
| POST | `/api/webhooks/:id/test` | Queue a `ping` event (202) |
| GET | `/api/webhooks/:id/deliveries` | Delivery history from MongoDB, paginated |

Events you can subscribe to: `booking.confirmed` (sent when a booking becomes final: after payment, or at once for a
free event), `booking.cancelled`, `booking.expired` (unpaid seats were released) and `event.finished`.

**What a receiver gets** (`POST`, `Content-Type: application/json`):

```json
{
  "id": "5f0c1a52-...",
  "event": "booking.confirmed",
  "createdAt": "2026-09-30T07:31:13.168Z",
  "data": { "bookingId": "...", "userId": "...", "eventId": "...", "eventTitle": "Jazz Night", "quantity": 2, "seatsLeft": 8 }
}
```

| Header | Meaning |
|---|---|
| `X-Webhook-Id` | Unique delivery id (same as `id` in the body). Use it to ignore duplicates |
| `X-Webhook-Event` | Event name |
| `X-Webhook-Timestamp` | Unix seconds when this attempt was sent |
| `X-Webhook-Signature` | `sha256=` plus the hex HMAC-SHA256 of `"<timestamp>.<raw body>"` using your secret |

Reply with any **2xx within 5 seconds**. Anything else is retried: 6 attempts in total, waiting 30s, 1m, 2m, 4m
and 8m. After 5 deliveries in a row fail completely, the endpoint is switched off (re-enable with `PATCH`).
In development, `http://localhost` targets are allowed. In production only public `https` URLs are accepted.

**Try it locally:**
1. Register `http://localhost:4000/hook` with `POST /api/webhooks` and copy the returned `secret`.
2. In another terminal: `WEBHOOK_SECRET=whsec_... node examples/webhook-receiver.js`
3. Send a `POST /api/webhooks/:id/test`, or make a booking, and watch the receiver print the event.

## How the important parts work

**Never selling the last seat twice.** Booking runs in one transaction, and the seat check and subtraction
are a single atomic statement: `UPDATE Event SET seatsLeft = seatsLeft - ? WHERE id = ? AND seatsLeft >= ?`.
If it matches no row, the event is sold out (409). Cancelling flips the status with
`WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED')`, so simultaneous cancels give the seats back only once.
See `src/modules/bookings/bookings.service.js`.

**Caching.** The events list is cached in Redis for 60 seconds under a versioned key (`events:v<N>:<query>`).
Clearing the cache means bumping the version number, which makes every old key unreachable instantly. Any
event change, booking, cancel or cron run bumps it. If Redis is down, requests fall through to MySQL.

**Background jobs.** After a booking commits, a job goes onto a BullMQ queue. A worker writes the
notification (as an upsert, so retries are safe) and then sends the email. Failed jobs retry 3 times with
exponential backoff. If Redis is down, the notification is written directly and no email is sent.

**Webhooks.** Admins register a URL and the events they want. When something happens, one job per subscribed
endpoint is queued. The worker POSTs a JSON body signed with HMAC-SHA256, and treats anything but a 2xx answer
(or a timeout) as a failed attempt to retry with exponential backoff. Registered URLs and the actual
connection are both checked against private addresses (SSRF). See the Webhooks diagrams above and the
`examples/webhook-receiver.js` script for the receiving side.

**Payments.** Booking a paid event only *holds* the seats (`PENDING_PAYMENT`, 15 minutes). The booking becomes
`CONFIRMED` only when the payment provider's signed webhook says the money arrived. The webhook route checks the
signature on the raw body, ignores duplicate event ids (an inbox table), compares the paid amount with the
price stored at booking time, and changes state only with conditional updates, so repeated or reordered events
cannot corrupt anything. Unpaid holds expire and give the seats back. Money that arrives for a booking that no
longer exists is refunded. See "Paying for a booking" above. Try it with the fake provider (see the API reference).

**Cron.** Every 10 minutes, and once at startup, events whose date has passed are marked `FINISHED`
(and an `event.finished` webhook is sent for each). Every minute, unpaid bookings past their hold are expired, and
any payment that succeeded for a cancelled or expired booking but was not refunded yet gets refunded.

**Request IDs.** Every request gets an ID (or reuses a safe `X-Request-Id` sent by the client), returned in
the `X-Request-Id` response header and included on every log line, including background job logs.

## Testing

Tests run against a separate database so they can never touch your real data. They delete all rows, and
`tests/helpers.js` refuses to run unless the database name contains `_test`.

1. Create `.env.test` in the project root (gitignored):

   ```env
   NODE_ENV=test
   DATABASE_URL="mysql://root:YOUR_PASSWORD@127.0.0.1:3306/event_booking_test"
   JWT_SECRET="any-test-secret-with-16-plus-chars"
   JWT_EXPIRES_IN=1d
   ```
2. Apply migrations to the test database once: `npm run test:migrate`
3. Run: `npm test`

In test mode the cache is bypassed and jobs are not queued, so tests need neither Redis nor MongoDB.
Current coverage (84 tests):
- auth, events, the booking and cancel flow including concurrency, and live socket updates
- outgoing webhooks: signing, SSRF protection, the admin API, who gets which event, and real deliveries to a local
  receiver covering success, retries, timeouts, redirects and auto-disable
- payments: the price snapshot, free events, the signed payment webhook (bad signature, replay, tampering,
  duplicates, amount mismatch), expiry, late payments, refunds and their retry, and payment-versus-cancel races

Reviews and notifications are not covered yet.

## Project structure

```
prisma/schema.prisma          User, Event, Booking, Payment, PaymentWebhookEvent, WebhookEndpoint models
prisma.config.ts              Prisma 7 config (reads DATABASE_URL)
public/live-seats.html        Socket.io demo page
examples/webhook-receiver.js  A standalone webhook receiver that verifies signatures (for trying webhooks)
src/
  server.js                   Connects Mongo, starts HTTP, sockets, worker, cron; graceful shutdown
  app.js                      Express app and middleware (no listen, so tests can import it)
  config/                     env.js (Zod-validated), prisma.js, mongo.js, redis.js
  middleware/                 auth.js, role.js, validate.js, errorHandler.js, requestId.js
  utils/                      AppError, asyncHandler, logger, cache, mailer
  modules/
    auth/  events/  bookings/ MySQL-backed features (schema, controller, routes)
    reviews/  notifications/  MongoDB-backed features (Mongoose models)
    webhooks/                 OUTGOING webhooks: endpoints (MySQL), delivery log (MongoDB), signing + SSRF checks
    payments/                 INCOMING payment webhook, orders, refunds; providers/ holds the fake provider
  jobs/                       queue.js, worker.js, webhookWorker.js, cron.js
  sockets/index.js            Socket.io setup and seat broadcasts
tests/                        Supertest and socket tests
```

## Known limitations

- Payments run against a **fake provider** only (no real money moves). A real Razorpay or Stripe adapter still has
  to be written behind the same interface (`src/modules/payments/providers/`), and the fake provider refuses to
  start in production.
- Refunds are always for the full amount. There are no partial refunds, and no automatic handling of provider-side
  disputes or chargebacks.
- The payment webhook applies its changes inside the request (a few fast queries), instead of queueing them. That
  way a 2xx answer really means "processed". Very heavy follow-up work should be queued.
- No rate limiting, `helmet` or refresh tokens.
- The worker and cron run inside the API process. In production, run the worker separately and run cron on
  one instance only.
- Socket.io would need the Redis adapter to work across multiple server instances.
- Webhooks are delivered **at least once** and **without ordering guarantees**: a receiver can see the same event
  twice (use `X-Webhook-Id` to deduplicate) and a retried `booking.confirmed` can arrive after a later
  `booking.cancelled`.
- A crash between the booking commit and queueing a webhook can lose that webhook. The proper fix is the
  outbox pattern (write the event to a table inside the same transaction, then publish it).
- If Redis is down when an event happens, its webhook deliveries are skipped (there is no direct fallback like
  the email one, because a webhook needs the retry queue). The failure is logged.
- Webhook secrets are stored in plain text, because HMAC signing needs the raw value. Encrypt them at rest in
  a real deployment.
- Reviews, notifications, the delivery-log endpoint, and the BullMQ email and webhook workers have not been tested
  against real MongoDB and Redis servers.
