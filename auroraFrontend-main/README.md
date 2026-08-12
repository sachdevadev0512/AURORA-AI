# Aurora Frontend

Professional React + TypeScript dashboard for Amazon sellers, built with modern UI components and data visualization.

## Features
- **Dashboard**: Key metrics, revenue charts, order status distribution
- **Products**: Searchable product listings with status filters, sync from Amazon
- **Orders**: Order management with search, filters, and detailed views
- **Integration**: Amazon SP-API credential setup
- **Settings**: Account management
- **Authentication**: Secure login/registration with JWT

## Tech Stack
- React 18 + TypeScript
- Vite for build tooling
- Recharts for data visualization
- Lucide React for icons
- Custom CSS with CSS variables

## Setup
1. Install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env with your backend URL
```

3. Start development server:
```bash
npm run dev
```

## Backend Integration
Requires Aurora backend running at `VITE_API_BASE_URL` (default: `http://localhost:5000/api`).

## Key Pages
- `/dashboard` - Overview with charts and sync controls
- `/products` - Product inventory management
- `/orders` - Order tracking and details
- `/integration` - Amazon API setup
- `/settings` - User preferences

## Professional Features
- Responsive design for mobile/tablet
- Real-time data sync with Amazon SP-API
- Advanced filtering and search
- Status badges and visual indicators
- Loading states and error handling
- Professional dark theme UI
