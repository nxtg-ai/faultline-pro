"""Faultline SDK exception types."""
from __future__ import annotations


class FaultlineError(Exception):
    """Raised when the Faultline API returns an error response.

    Attributes:
        status_code: HTTP status code returned by the API.
        body: Parsed JSON body of the error response (empty dict if unparseable).
    """

    def __init__(self, message: str, status_code: int, body: dict | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body or {}
