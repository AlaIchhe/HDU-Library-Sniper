use super::*;

/// 前端停止轮询多久后，服务端扫码循环自行退出。
const QR_POLL_IDLE_MS: i64 = 15_000;

impl AuthService {
    pub async fn create_qr_login(self: &Arc<Self>) -> Result<QrLoginStart, AuthError> {
        let permit = self
            .qr_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| AuthError::Busy)?;
        let referer = self.ensure_sso_page().await?;
        let timestamp = Utc::now().timestamp_millis();
        let response = self
            .follow(
                &format!(
                    "{}/api/protected/qrlogin/loginid?{timestamp}",
                    self.endpoints.sso
                ),
                Method::GET,
                self.sso_headers(referer.as_str()),
                None,
            )
            .await?;
        if !response.status().is_success() {
            return Err(AuthError::Invalid(format!(
                "二维码 ID 请求失败: {}",
                response.status()
            )));
        }
        let body = self.read_sso_json(response).await?;
        let uuid = body
            .get("data")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AuthError::Invalid("二维码 ID 无效".into()))?
            .to_string();
        let image_response = self
            .follow(
                &format!(
                    "{}/api/public/qrlogin/qrgen/{}/dingDingQr?t={timestamp}",
                    self.endpoints.sso,
                    urlencoding::encode(&uuid)
                ),
                Method::GET,
                vec![
                    (
                        "Accept".into(),
                        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8".into(),
                    ),
                    (HEADER_USER_AGENT.to_string(), USER_AGENT.into()),
                    ("Referer".into(), referer.to_string()),
                ],
                None,
            )
            .await?;
        if !image_response.status().is_success() {
            return Err(AuthError::Invalid(format!(
                "二维码生成失败: {}",
                image_response.status()
            )));
        }
        let bytes = image_response
            .bytes()
            .await
            .map_err(|error| AuthError::Invalid(error.to_string()))?;
        if bytes.is_empty() {
            return Err(AuthError::Invalid("二维码内容为空".into()));
        }
        let image = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        self.qr_sessions
            .lock()
            .expect("qr sessions poisoned")
            .insert(
                uuid.clone(),
                QrSession {
                    created_at: Utc::now().timestamp_millis(),
                    last_polled_at: Utc::now().timestamp_millis(),
                    status: "waiting".into(),
                    message: None,
                    session: None,
                },
            );
        self.prune_qr_sessions();
        let service = self.clone();
        let scan_uuid = uuid.clone();
        tokio::spawn(async move {
            let _permit = permit;
            service.run_qr_scan_loop(scan_uuid).await;
        });
        Ok(QrLoginStart {
            uuid,
            image,
            ttl_seconds: 90,
        })
    }

    pub fn poll_qr_login(&self, uuid: &str) -> QrLoginStatus {
        let now = Utc::now().timestamp_millis();
        let entry = {
            let mut sessions = self.qr_sessions.lock().expect("qr sessions poisoned");
            sessions.get_mut(uuid).map(|entry| {
                entry.last_polled_at = now;
                entry.clone()
            })
        };
        match entry {
            Some(entry) => QrLoginStatus {
                status: entry.status,
                message: entry.message,
                session: entry.session,
            },
            None => QrLoginStatus {
                status: "error".into(),
                message: Some("二维码已失效，请刷新".into()),
                session: None,
            },
        }
    }

    /// 前端离开扫码页时调用：让服务端停止扫码轮询。
    ///
    /// 扫码循环会持续请求 SSO 直到二维码过期；它和密码登录共用同一个
    /// `auth_jar`，登录页的 `croypto`/`flowkey` 又和当次 `SESSION` 绑定，
    /// 所以“看了二维码再改用密码登录”会被正在跑的扫码循环搅乱。
    pub fn cancel_qr_login(&self, uuid: &str) -> bool {
        self.qr_sessions
            .lock()
            .expect("qr sessions poisoned")
            .remove(uuid)
            .is_some()
    }

    fn prune_qr_sessions(&self) {
        let cutoff = Utc::now().timestamp_millis() - 10 * 60_000;
        let mut sessions = self.qr_sessions.lock().expect("qr sessions poisoned");
        sessions.retain(|_, entry| entry.created_at >= cutoff);
    }

    async fn poll_qr_round_for_token(&self, uuid: &str) -> Result<Option<String>, AuthError> {
        let referer = self.ensure_sso_page().await?;
        let timestamp = Utc::now().timestamp_millis();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            self.follow(
                &format!(
                    "{}/api/protected/qrlogin/scan/{}?{timestamp}",
                    self.endpoints.sso,
                    urlencoding::encode(uuid)
                ),
                Method::GET,
                self.sso_headers(referer.as_str()),
                None,
            ),
        )
        .await;
        let response = match result {
            Err(_) => return Ok(None),
            Ok(Err(error)) => return Err(error),
            Ok(Ok(response)) => response,
        };
        if !response.status().is_success() {
            return Err(AuthError::Invalid(format!(
                "扫码状态请求失败: {}",
                response.status()
            )));
        }
        let body = self.read_sso_json(response).await?;
        if let Some(token) = body
            .get("data")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Ok(Some(token.to_string()));
        }
        Err(AuthError::Invalid("二维码已过期，请刷新".into()))
    }

    async fn complete_qr_login(&self, token: &str) -> Result<(), AuthError> {
        // 与手动登录/后台刷新串行，避免两次登录同时写回会话。
        let _gate = self.login_gate.lock().await;
        if token.is_empty() {
            return Err(AuthError::Invalid("扫码授权令牌为空".into()));
        }
        let response = self
            .follow(
                &self.endpoints.sso_login_page,
                Method::POST,
                vec![
                    (HEADER_USER_AGENT.to_string(), USER_AGENT.into()),
                    ("Origin".into(), self.endpoints.sso.clone()),
                    ("Referer".into(), self.endpoints.sso_login_page.clone()),
                ],
                Some(vec![(token.to_string(), "login".into())]),
            )
            .await?;
        if response.url().as_str().starts_with(&self.endpoints.sso)
            && !response.url().as_str().contains("huitu.zhishulib.com")
        {
            return Err(AuthError::Invalid("扫码登录未完成，请重新扫码".into()));
        }
        self.sync_cookies_to_client();
        if !self.client.validate().await || self.client.uid().is_empty() {
            return Err(AuthError::Invalid("扫码登录后 Cookie 无效".into()));
        }
        self.persist().await?;
        Ok(())
    }

    async fn run_qr_scan_loop(&self, uuid: String) {
        let budget = Utc::now().timestamp_millis() + 90_000;
        while Utc::now().timestamp_millis() < budget {
            let entry = {
                let sessions = self.qr_sessions.lock().expect("qr sessions poisoned");
                sessions.get(&uuid).cloned()
            };
            let Some(entry) = entry else {
                return;
            };
            if entry.status != "waiting" {
                return;
            }
            if Utc::now().timestamp_millis() - entry.last_polled_at > QR_POLL_IDLE_MS {
                log::info!("扫码轮询停止：前端已不再轮询 uuid={uuid}");
                self.qr_sessions
                    .lock()
                    .expect("qr sessions poisoned")
                    .remove(&uuid);
                return;
            }
            match self.poll_qr_round_for_token(&uuid).await {
                Ok(Some(token)) => match self.complete_qr_login(&token).await {
                    Ok(()) => {
                        let session = self.status();
                        self.qr_sessions
                            .lock()
                            .expect("qr sessions poisoned")
                            .insert(
                                uuid,
                                QrSession {
                                    created_at: entry.created_at,
                                    last_polled_at: entry.last_polled_at,
                                    status: "confirmed".into(),
                                    message: None,
                                    session: Some(session),
                                },
                            );
                        return;
                    }
                    Err(error) => {
                        self.qr_sessions
                            .lock()
                            .expect("qr sessions poisoned")
                            .insert(
                                uuid,
                                QrSession {
                                    created_at: entry.created_at,
                                    last_polled_at: entry.last_polled_at,
                                    status: "error".into(),
                                    message: Some(error.to_string()),
                                    session: None,
                                },
                            );
                        return;
                    }
                },
                Ok(None) => continue,
                Err(error) => {
                    let message = error.to_string();
                    let expired = message.contains("expired") || message.contains("过期");
                    self.qr_sessions
                        .lock()
                        .expect("qr sessions poisoned")
                        .insert(
                            uuid,
                            QrSession {
                                created_at: entry.created_at,
                                last_polled_at: entry.last_polled_at,
                                status: if expired {
                                    "expired".into()
                                } else {
                                    "error".into()
                                },
                                message: Some(if expired {
                                    "二维码已过期，请刷新".into()
                                } else {
                                    message
                                }),
                                session: None,
                            },
                        );
                    return;
                }
            }
        }
        self.qr_sessions
            .lock()
            .expect("qr sessions poisoned")
            .insert(
                uuid,
                QrSession {
                    created_at: Utc::now().timestamp_millis(),
                    last_polled_at: Utc::now().timestamp_millis(),
                    status: "expired".into(),
                    message: Some("二维码已过期，请刷新".into()),
                    session: None,
                },
            );
    }
}
