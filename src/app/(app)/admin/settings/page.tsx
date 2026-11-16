import { requirePermission } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { CompanyForm } from './CompanyForm';

export const metadata = { title: 'Company settings' };

export default async function SettingsPage() {
  await requirePermission('settings.company.manage');
  const { rows } = await query(`SELECT company_name, address, phone, email, vat_reg_no FROM company_settings WHERE id = 1`);
  return (
    <main className="wrap page page-narrow">
      <div className="pagehead">
        <div><h1>Company settings</h1><p>Shown on BOQ offers and used as the default sender name on e-mails.</p></div>
      </div>
      <CompanyForm row={rows[0]} />
    </main>
  );
}
