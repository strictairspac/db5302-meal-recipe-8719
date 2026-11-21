from typing import Any, Union

from pydantic import BaseModel, Field


class LoginForm(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=128)


class CaseForm(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    payload: dict[str, Any]


class ReviewForm(BaseModel):
    note: str = Field(min_length=1, max_length=500)


class ErrataForm(BaseModel):
    parent: str = Field(min_length=1, max_length=32)
    component: str = Field(min_length=1, max_length=32)
    qty: Union[int, float, str]
    note: str = Field(default='', max_length=200)
