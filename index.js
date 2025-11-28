require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);

const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("plantsDB");
    const plantsCollections = db.collection("plants");
    const ordersCollections = db.collection("orders");
    //post a plants
    app.post("/plants", async (req, res) => {
      const plantData = req.body;
      const result = await plantsCollections.insertOne(plantData);
      res.send(result);
    });

    //get all plants
    app.get("/plants", async (req, res) => {
      try {
        const plants = await plantsCollections.find().toArray();
        res.send(plants);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch plants" });
      }
    });

    //get on plant api

    app.get("/plants/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await plantsCollections.findOne(query);
        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch plants" });
      }
    });

    //payments  end points
    app.post("/create/checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      // console.log(paymentInfo);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: paymentInfo?.price * 100,
              product_data: {
                name: paymentInfo?.name,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
            },
            quantity: paymentInfo?.quantity,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          plantId: paymentInfo?.plantId,
          customer: paymentInfo?.customer.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        // success_url: "http://localhost:5173/payment-success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: `${process.env.CLIENT_DOMAIN}/plant/${paymentInfo?.plantId}`,
      });
      res.send({ url: session.url });
    });

    //payment order post in the database
    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const plant = await plantsCollections.findOne({
          _id: new ObjectId(session.metadata?.plantId),
        });

        if (!plant) {
          return res.send({ error: "Product not found" });
        }

        if (plant.quantity < 1) {
          return res.send({
            outOfStock: true,
            message: "Product is out of stock",
          });
        }

        const order = await ordersCollections.findOne({
          transactionId: session.payment_intent,
        });

        // Stripe returns status inside session.payment_status (recommended)
        if (session.payment_status === "paid" && plant && !order) {
          const orderInfo = {
            plantId: session.metadata.plantId,
            transactionId: session.payment_intent,
            customer: session.metadata.customer,
            status: "pending",
            seller: plant.seller,
            name: plant.name,
            category: plant.category,
            quantity: 1,
            price: session.amount_total / 100,
            image: plant?.image,
            date: new Date(),
          };

          const result = await ordersCollections.insertOne(orderInfo);

          //update plant quantity
          await plantsCollections.updateOne(
            {
              _id: new ObjectId(session.metadata?.plantId),
            },
            {
              $inc: { quantity: -1 },
            }
          );

          return res.send({
            transactionId: session.payment_intent,
            orderId: result.insertedId,
          });
        }

        res.send({ success: false, message: "Payment not completed" });
      } catch (error) {
        console.log(error);
        res.status(500).send({ error: error.message });
      }
    });

    //get all orders for a customer by email

    app.get("/my-orders/:email", async (req, res) => {
      const email = req.params.email;

      const result = await ordersCollections
        .find({ customer: email })
        .toArray();

      res.send(result);
    });

    //get all orders for a seller by email
    app.get("/manage-orders/:email", async (req, res) => {
      const email = req.params.email;

      const result = await ordersCollections
        .find({ 'seller.email' : email })
        .toArray();

      res.send(result);
    });


    //get all plants for a seller by email
    app.get("/my-inventory/:email", async (req, res) => {
      const email = req.params.email;

      const result = await plantsCollections
        .find({ 'seller.email' : email })
        .toArray();

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
