<?php

declare(strict_types=1);

namespace OCA\Nextdesk\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\IUserSession;

class SettingsController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private IConfig $config,
        private IUserSession $userSession,
        private IGroupManager $groupManager,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * Saves the Nextdesk URL. Admin settings pages are only linked for
     * admins, but the route itself isn't otherwise protected — check here
     * too rather than trust that.
     */
    public function save(string $url): JSONResponse {
        $user = $this->userSession->getUser();
        if ($user === null || !$this->groupManager->isAdmin($user->getUID())) {
            return new JSONResponse(['error' => 'Forbidden'], 403);
        }

        $url = rtrim(trim($url), '/');
        if ($url !== '' && filter_var($url, FILTER_VALIDATE_URL) === false) {
            return new JSONResponse(['error' => 'Not a valid URL'], 422);
        }

        $this->config->setAppValue($this->appName, 'url', $url);
        return new JSONResponse(['url' => $url]);
    }
}
