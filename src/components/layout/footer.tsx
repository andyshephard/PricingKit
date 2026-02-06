import { Github } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t bg-background">
      <div className="container mx-auto px-4 py-6 flex items-center justify-between text-sm text-muted-foreground">
        <span>&copy; {new Date().getFullYear()} PricingKit</span>
        <a
          href="https://github.com/andyshephard/PricingKit"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:text-foreground transition-colors"
        >
          <Github className="h-4 w-4" />
          <span>Free and open-source, forever.</span>
        </a>
      </div>
    </footer>
  );
}
