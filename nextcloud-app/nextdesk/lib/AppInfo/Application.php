<?php

declare(strict_types=1);

namespace OCA\Nextdesk\AppInfo;

use OCA\Nextdesk\Listener\LoadFilesActionListener;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Files\Events\LoadAdditionalScriptsEvent;

class Application extends App implements IBootstrap {
    public const APP_ID = 'nextdesk';

    public function __construct(array $urlParams = []) {
        parent::__construct(self::APP_ID, $urlParams);
    }

    public function register(IRegistrationContext $context): void {
        // Navigation entry and admin settings section are declared in
        // appinfo/info.xml — nothing to register here for those.

        // "Open in Nextdesk" Files action — enqueues js/nextdesk-files-action.mjs
        // on the Files page (only once a Nextdesk URL is configured).
        $context->registerEventListener(LoadAdditionalScriptsEvent::class, LoadFilesActionListener::class);
    }

    public function boot(IBootContext $context): void {
    }
}
