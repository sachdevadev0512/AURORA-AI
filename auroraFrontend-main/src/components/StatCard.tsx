import { ReactNode } from 'react';

interface StatCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  trend?: string;
  description?: string;
}

export default function StatCard({ title, value, icon, trend, description }: StatCardProps) {
  return (
    <div className="short-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {icon}
        <h3>{value}</h3>
      </div>
      <p>{title}</p>
      {(trend || description) && <small style={{ color: '#aab9d6' }}>{trend || description}</small>}
    </div>
  );
}
