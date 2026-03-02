// prisma/seed.ts
import { PrismaClient, AmpelStatus, Temperatur, DealStage } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Clear existing data
  await prisma.activity.deleteMany();
  await prisma.document.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.user.deleteMany();

  console.log('✅ Cleared existing data');

  // Create users
  const users = await Promise.all([
    prisma.user.create({
      data: {
        email: 'admin@immokredit.at',
        name: 'Admin User',
        password: '$2a$10$rKw8qKx8qKx8qKx8qKx8qO', // "password123" - change in production!
        role: 'ADMIN',
      },
    }),
    prisma.user.create({
      data: {
        email: 'agent@immokredit.at',
        name: 'Sales Agent',
        password: '$2a$10$rKw8qKx8qKx8qKx8qKx8qO', // "password123"
        role: 'AGENT',
      },
    }),
  ]);

  console.log(`✅ Created ${users.length} users`);

  // Create leads with deals
  const leadsData = [
    {
      firstName: 'Maria',
      lastName: 'Schmidt',
      email: 'maria.schmidt@example.com',
      phone: '+43 664 111 1111',
      source: 'Facebook',
      amount: 250000,
      ampelStatus: AmpelStatus.YELLOW,
      temperatur: Temperatur.WARM,
      score: 50,
      deal: {
        title: 'Maria Schmidt - Facebook',
        value: 250000,
        stage: DealStage.NEUER_LEAD,
      },
    },
    {
      firstName: 'Peter',
      lastName: 'Wagner',
      email: 'peter.wagner@example.com',
      phone: '+43 664 222 2222',
      source: 'Website',
      amount: 180000,
      ampelStatus: AmpelStatus.RED,
      temperatur: Temperatur.COLD,
      score: 25,
      deal: {
        title: 'Peter Wagner - Website',
        value: 180000,
        stage: DealStage.NEUER_LEAD,
      },
    },
    {
      firstName: 'Lisa',
      lastName: 'Müller',
      email: 'lisa.mueller@example.com',
      phone: '+43 664 333 3333',
      source: 'Empfehlung',
      amount: 320000,
      ampelStatus: AmpelStatus.GREEN,
      temperatur: Temperatur.HOT,
      score: 92,
      kaufwahrscheinlichkeit: 85,
      deal: {
        title: 'Lisa Müller - Empfehlung',
        value: 320000,
        stage: DealStage.QUALIFIZIERT,
        kaufzeitpunkt: '0-3M',
        eigenmittel: 'Ja',
        immobilieStatus: 'Konkret',
      },
    },
    {
      firstName: 'Thomas',
      lastName: 'Bauer',
      email: 'thomas.bauer@example.com',
      phone: '+43 664 444 4444',
      source: 'Google Ads',
      amount: 290000,
      ampelStatus: AmpelStatus.GREEN,
      temperatur: Temperatur.HOT,
      score: 88,
      kaufwahrscheinlichkeit: 80,
      deal: {
        title: 'Thomas Bauer - Google Ads',
        value: 290000,
        stage: DealStage.UNTERLAGEN_SAMMELN,
        kaufzeitpunkt: '0-3M',
        eigenmittel: 'Teilweise',
        immobilieStatus: 'Konkret',
      },
    },
    {
      firstName: 'Anna',
      lastName: 'Huber',
      email: 'anna.huber@example.com',
      phone: '+43 664 555 5555',
      source: 'Facebook',
      amount: 210000,
      ampelStatus: AmpelStatus.YELLOW,
      temperatur: Temperatur.WARM,
      score: 55,
      deal: {
        title: 'Anna Huber - Facebook',
        value: 210000,
        stage: DealStage.QUALIFIZIERT,
      },
    },
  ];

  for (const leadData of leadsData) {
    const { deal: dealData, ...leadInfo } = leadData;

    const lead = await prisma.lead.create({
      data: {
        ...leadInfo,
        deal: {
          create: {
            ...dealData,
            pipedriveDealId: Math.floor(Math.random() * 10000) + 1000, // Mock ID
          },
        },
      },
    });

    // Create activities
    await prisma.activity.createMany({
      data: [
        {
          leadId: lead.id,
          type: 'LEAD_CREATED',
          title: 'Lead erstellt',
          description: `Lead wurde erstellt über ${lead.source}`,
        },
        {
          leadId: lead.id,
          type: 'DEAL_CREATED',
          title: 'Deal erstellt',
          description: 'Deal wurde in Pipedrive angelegt',
        },
      ],
    });
  }

  console.log(`✅ Created ${leadsData.length} leads with deals`);

  // Get counts
  const leadCount = await prisma.lead.count();
  const dealCount = await prisma.deal.count();
  const activityCount = await prisma.activity.count();

  console.log(`
🎉 Database seeded successfully!

📊 Summary:
   - Users: ${users.length}
   - Leads: ${leadCount}
   - Deals: ${dealCount}
   - Activities: ${activityCount}

🔐 Test Users:
   - admin@immokredit.at (ADMIN)
   - agent@immokredit.at (AGENT)
   Password for both: password123

🚀 You can now start the server!
  `);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
