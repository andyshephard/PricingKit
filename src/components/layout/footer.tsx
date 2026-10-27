import Link from 'next/link';
import { GITHUB_URL, LICENSE_NAME, ROUTES } from '@/config/site';

const footLink = 'rounded-md text-soft transition-colors hover:text-foreground';

/** The small footer under app screens and the setup guides. */
export function Footer() {
  return (
    <footer className="border-t">
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 text-sm text-muted-foreground sm:px-8">
        <span>
          PricingKit · {LICENSE_NAME} · free and open source
        </span>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-5">
            <li>
              <Link href={ROUTES.indexChecker} className={footLink}>
                Index checker
              </Link>
            </li>
            <li>
              <Link href={ROUTES.docs} className={footLink}>
                Docs
              </Link>
            </li>
            <li>
              <a href={GITHUB_URL} className={footLink} rel="noopener noreferrer">
                GitHub
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
