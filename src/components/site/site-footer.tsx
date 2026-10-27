import Link from 'next/link';
import { GITHUB_URL, LICENSE_NAME, REPO_LINKS, ROUTES } from '@/config/site';

const footLink = 'rounded-md text-soft transition-colors hover:text-foreground';

export function SiteFooter() {
  return (
    <footer className="border-t bg-header">
      <div className="mx-auto flex max-w-[1200px] flex-wrap justify-between gap-6 px-4 py-8 text-sm text-muted-foreground sm:px-8">
        <span>
          PricingKit · {LICENSE_NAME}
        </span>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-5">
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
            <li>
              <a href={REPO_LINKS.changelog} className={footLink} rel="noopener noreferrer">
                Changelog
              </a>
            </li>
            <li>
              <a href={REPO_LINKS.security} className={footLink} rel="noopener noreferrer">
                Security
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
