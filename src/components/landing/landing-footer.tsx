import Link from 'next/link';
import { Github } from 'lucide-react';

export function LandingFooter() {
  return (
    <footer className="border-t bg-muted/30">
      <div className="container mx-auto px-4 py-10">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex flex-col items-center md:items-start gap-1">
            <Link href="/" className="text-lg font-bold">
              PricingKit
            </Link>
            <p className="text-sm text-muted-foreground">
              Smarter regional pricing for the App Store and Google Play.
            </p>
            <a
              href="https://github.com/andyshephard/PricingKit"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mt-1"
            >
              <Github className="h-4 w-4" />
              Free and open-source, forever.
            </a>
          </div>

        </div>
      </div>
    </footer>
  );
}
