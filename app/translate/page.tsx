import { Suspense } from "react";
import UserBadge from "@/components/UserBadge";
import TranslatorWorkspace from "@/components/TranslatorWorkspace";

export default function TranslatePage() {
  return (
    <div className="appShell">
      <header className="appHeader">
        <div className="brand">
          <span className="brandMark">अ</span>
          <span className="brandName">Anuvad</span>
        </div>
        <Suspense fallback={<div className="headerRight" />}>
          <UserBadge />
        </Suspense>
      </header>

      <TranslatorWorkspace />
    </div>
  );
}
