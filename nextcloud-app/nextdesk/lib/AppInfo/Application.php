<?php

declare(strict_types=1);

namespace OCA\Nextdesk\AppInfo;

use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

class Application extends App implements IBootstrap {
    public const APP_ID = 'nextdesk';

    public function __construct(array $urlParams = []) {
        parent::__construct(self::APP_ID, $urlParams);
    }

    public function register(IRegistrationContext $context): void {
        // Navigation entry and admin settings section are declared in
        // appinfo/info.xml — nothing to register here for those.
    }

    public function boot(IBootContext $context): void {
    }
}
