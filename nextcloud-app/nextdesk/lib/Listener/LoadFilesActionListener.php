<?php

declare(strict_types=1);

namespace OCA\Nextdesk\Listener;

use OCP\AppFramework\Services\IInitialState;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Events\LoadAdditionalScriptsEvent;
use OCP\IConfig;
use OCP\Util;

/**
 * @template-implements IEventListener<LoadAdditionalScriptsEvent>
 */
class LoadFilesActionListener implements IEventListener {
    public function __construct(
        private IConfig $config,
        private IInitialState $initialState,
    ) {
    }

    public function handle(Event $event): void {
        if (!($event instanceof LoadAdditionalScriptsEvent)) {
            return;
        }

        $url = rtrim((string) $this->config->getAppValue('nextdesk', 'url', ''), '/');
        if ($url === '') {
            // Not configured yet (see Settings → Administration → Nextdesk) —
            // nothing for the Files "Open in Nextdesk" action to point at.
            return;
        }

        $this->initialState->provideInitialState('url', $url);
        // Matches vite.config.js's output convention (createAppConfig's
        // default "<appId>-<entry-name>.mjs" naming) — see js/nextdesk-files-action.mjs.
        Util::addScript('nextdesk', 'nextdesk-files-action');
    }
}
